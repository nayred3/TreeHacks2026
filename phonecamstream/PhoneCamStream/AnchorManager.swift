import Foundation
import MultipeerConnectivity
import NearbyInteraction
import CoreMotion
import simd
import UIKit

// MARK: - Peer message protocol

let kServiceType = "pcstream"  // MultipeerConnectivity service name

struct PeerMsg: Codable {
    enum Kind: String, Codable {
        case niToken         // NI discovery token (base64)
        case cameraInfo      // mover → anchor: camera_id
        case positionUpdate  // anchor → mover: [x, y]
        case headingUpdate   // mover → anchor: heading degrees
    }
    let kind: Kind
    let payload: String
}

// MARK: - Mover tracking data

struct MoverData: Identifiable {
    let id: String               // camera_id
    var peerID: MCPeerID
    var distance: Float?
    var direction: simd_float3?
    var position: [Double] = [0, 0]
    var heading: Double = 0
}

// MARK: - Anchor Manager

/// Runs on the central/anchor phone.
/// - Advertises via MultipeerConnectivity
/// - Manages one NISession per connected mover
/// - Computes each mover's world position from UWB distance + direction
/// - Sends position back to the mover (mover then forwards to Justin's Mac)
class AnchorManager: NSObject, ObservableObject {

    // Published state
    @Published var movers: [String: MoverData] = [:]       // camera_id → data
    @Published var connectedCount: Int = 0
    @Published var isAdvertising = false

    // Heading (anchor's own compass) — needed to convert UWB direction to world
    @Published var anchorHeading: Double = 0

    // MC
    private let myPeerID: MCPeerID
    private var mcSession: MCSession!
    private var advertiser: MCNearbyServiceAdvertiser!

    // NI — one session per mover
    private var niSessions: [MCPeerID: NISession] = [:]

    // Peer → camera_id mapping
    private var peerToCameraID: [MCPeerID: String] = [:]

    // Motion (for attitude when computing world position)
    private let motionManager = CMMotionManager()

    // Compass
    private let headingTracker = HeadingTracker()

    // Position sender → Justin's Mac
    var positionSender: PositionSender?

    override init() {
        myPeerID = MCPeerID(displayName: UIDevice.current.name)
        super.init()

        mcSession = MCSession(peer: myPeerID, securityIdentity: nil,
                              encryptionPreference: .none)
        mcSession.delegate = self

        advertiser = MCNearbyServiceAdvertiser(
            peer: myPeerID, discoveryInfo: ["role": "anchor"],
            serviceType: kServiceType)
        advertiser.delegate = self
    }

    func start() {
        advertiser.startAdvertisingPeer()
        headingTracker.start()
        motionManager.startDeviceMotionUpdates(using: .xMagneticNorthZVertical)
        isAdvertising = true
        print("[Anchor] Advertising started")

        // Observe heading
        headingTracker.$heading
            .receive(on: RunLoop.main)
            .assign(to: &$anchorHeading)
    }

    func stop() {
        advertiser.stopAdvertisingPeer()
        mcSession.disconnect()
        niSessions.values.forEach { $0.invalidate() }
        niSessions.removeAll()
        headingTracker.stop()
        motionManager.stopDeviceMotionUpdates()
        positionSender?.stop()
        isAdvertising = false
    }

    // MARK: - Send helpers

    private func send(_ msg: PeerMsg, to peer: MCPeerID) {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        try? mcSession.send(data, toPeers: [peer], with: .reliable)
    }

    private func sendPositionToMover(_ cameraID: String, position: [Double]) {
        guard let peer = peerToCameraID.first(where: { $0.value == cameraID })?.key else { return }
        let json = try! JSONEncoder().encode(position)
        let msg = PeerMsg(kind: .positionUpdate, payload: String(data: json, encoding: .utf8)!)
        send(msg, to: peer)
    }

    // MARK: - NI Session lifecycle

    private func createNISession(for peer: MCPeerID) {
        let session = NISession()
        session.delegate = self
        niSessions[peer] = session

        // Send our discovery token to the mover
        guard let token = session.discoveryToken else {
            print("[Anchor] No discovery token available (device may not support UWB)")
            return
        }
        guard let tokenData = try? NSKeyedArchiver.archivedData(
            withRootObject: token, requiringSecureCoding: true) else { return }

        let msg = PeerMsg(kind: .niToken, payload: tokenData.base64EncodedString())
        send(msg, to: peer)
        print("[Anchor] Sent NI token to \(peer.displayName)")
    }

    private func handleReceivedToken(from peer: MCPeerID, base64: String) {
        guard let tokenData = Data(base64Encoded: base64),
              let token = try? NSKeyedUnarchiver.unarchivedObject(
                ofClass: NIDiscoveryToken.self, from: tokenData) else {
            print("[Anchor] Failed to decode NI token from \(peer.displayName)")
            return
        }

        guard let session = niSessions[peer] else { return }
        let config = NINearbyPeerConfiguration(peerToken: token)
        session.run(config)
        print("[Anchor] NI session running with \(peer.displayName)")
    }

    // MARK: - Position computation

    /// Convert UWB distance + direction → world (x, y) using anchor heading.
    private func computeWorldPosition(distance: Float, direction: simd_float3?) -> [Double] {
        let dist = Double(distance)

        guard let dir = direction else {
            // Direction unavailable — put on the anchor's forward axis at measured distance
            let headingRad = anchorHeading * .pi / 180
            return [dist * cos(headingRad), dist * sin(headingRad)]
        }

        // Horizontal angle from the anchor phone's "forward" (top of phone when flat).
        // Device coords when flat: x = right, y = forward (top), z = up.
        let horizontalAngle = atan2(Double(dir.x), Double(dir.y))

        // Anchor heading is in math convention (0=East, 90=North).
        // "Forward" = direction the top of the phone points = anchor's compass heading.
        let headingRad = anchorHeading * .pi / 180
        let worldAngle = headingRad + horizontalAngle

        return [dist * cos(worldAngle), dist * sin(worldAngle)]
    }

    // MARK: - Incoming message dispatch

    fileprivate func handleMessage(_ data: Data, from peer: MCPeerID) {
        guard let msg = try? JSONDecoder().decode(PeerMsg.self, from: data) else { return }

        switch msg.kind {
        case .niToken:
            handleReceivedToken(from: peer, base64: msg.payload)

        case .cameraInfo:
            let cameraID = msg.payload
            peerToCameraID[peer] = cameraID
            DispatchQueue.main.async {
                if self.movers[cameraID] == nil {
                    self.movers[cameraID] = MoverData(id: cameraID, peerID: peer)
                }
            }
            print("[Anchor] Mover registered: \(cameraID)")
            // Start NI session now that we know who they are
            createNISession(for: peer)

        case .headingUpdate:
            if let heading = Double(msg.payload),
               let cameraID = peerToCameraID[peer] {
                DispatchQueue.main.async {
                    self.movers[cameraID]?.heading = heading
                }
            }

        case .positionUpdate:
            break // anchor doesn't receive position updates
        }
    }
}

// MARK: - MCSessionDelegate

extension AnchorManager: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID,
                 didChange state: MCSessionState) {
        DispatchQueue.main.async {
            self.connectedCount = session.connectedPeers.count
        }
        switch state {
        case .connected:
            print("[Anchor] Peer connected: \(peerID.displayName)")
        case .notConnected:
            print("[Anchor] Peer disconnected: \(peerID.displayName)")
            if let cameraID = peerToCameraID[peerID] {
                DispatchQueue.main.async { self.movers.removeValue(forKey: cameraID) }
            }
            niSessions[peerID]?.invalidate()
            niSessions.removeValue(forKey: peerID)
            peerToCameraID.removeValue(forKey: peerID)
        default: break
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        handleMessage(data, from: peerID)
    }

    // Unused but required
    func session(_ s: MCSession, didReceive stream: InputStream, withName n: String, fromPeer p: MCPeerID) {}
    func session(_ s: MCSession, didStartReceivingResourceWithName n: String, fromPeer p: MCPeerID, with pr: Progress) {}
    func session(_ s: MCSession, didFinishReceivingResourceWithName n: String, fromPeer p: MCPeerID, at u: URL?, withError e: Error?) {}
}

// MARK: - MCNearbyServiceAdvertiserDelegate

extension AnchorManager: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser,
                    didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?,
                    invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        // Auto-accept all movers
        invitationHandler(true, mcSession)
        print("[Anchor] Accepted invitation from \(peerID.displayName)")
    }
}

// MARK: - NISessionDelegate

extension AnchorManager: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let object = nearbyObjects.first else { return }

        // Find which peer this session belongs to
        guard let (peer, _) = niSessions.first(where: { $0.value === session }),
              let cameraID = peerToCameraID[peer] else { return }

        let distance = object.distance
        let direction = object.direction

        // Compute world position
        guard let dist = distance else { return }
        let position = computeWorldPosition(distance: dist, direction: direction)

        DispatchQueue.main.async {
            self.movers[cameraID]?.distance = dist
            self.movers[cameraID]?.direction = direction
            self.movers[cameraID]?.position = position
        }

        // Send position back to the mover
        sendPositionToMover(cameraID, position: position)

        // Also send camera_state to Justin's Mac for this mover
        let heading = movers[cameraID]?.heading ?? 0
        positionSender?.sendPosition(
            cameraID: cameraID,
            position: position,
            heading: heading,
            completion: nil
        )
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        print("[Anchor] NI object removed, reason: \(reason)")
    }

    func sessionWasSuspended(_ session: NISession) {
        print("[Anchor] NI session suspended")
    }

    func sessionSuspensionEnded(_ session: NISession) {
        // Re-run with the saved token
        if let (peer, _) = niSessions.first(where: { $0.value === session }),
           let cameraID = peerToCameraID[peer] {
            print("[Anchor] NI session resumed for \(cameraID)")
        }
    }

    func session(_ session: NISession, didInvalidateWith error: Error) {
        print("[Anchor] NI session invalidated: \(error.localizedDescription)")
    }
}
