import Foundation
import MultipeerConnectivity
import NearbyInteraction
import UIKit

/// Runs on each camera/mover phone.
/// - Browses for the anchor via MultipeerConnectivity
/// - Exchanges NI discovery tokens
/// - Runs an NISession with the anchor
/// - Receives position updates from the anchor (UWB-computed)
/// - Publishes `position` so StreamingView can forward it to Justin's Mac.
class MoverPeerClient: NSObject, ObservableObject {

    // Published state
    @Published var isConnectedToAnchor = false
    @Published var position: [Double]? = nil        // set by anchor
    @Published var distanceToAnchor: Float? = nil
    @Published var statusText: String = "Searching for anchor..."

    // Config
    var cameraID: String = "phone_1"

    // MC
    private let myPeerID: MCPeerID
    private var mcSession: MCSession!
    private var browser: MCNearbyServiceBrowser!

    // NI
    private var niSession: NISession?
    private var anchorPeer: MCPeerID?

    // Heading tracker (sends heading to anchor so it can forward camera_state)
    private let headingTracker = HeadingTracker()
    private var headingTimer: Timer?

    override init() {
        myPeerID = MCPeerID(displayName: UIDevice.current.name)
        super.init()

        mcSession = MCSession(peer: myPeerID, securityIdentity: nil,
                              encryptionPreference: .none)
        mcSession.delegate = self

        browser = MCNearbyServiceBrowser(peer: myPeerID, serviceType: kServiceType)
        browser.delegate = self
    }

    func start(cameraID: String) {
        self.cameraID = cameraID
        browser.startBrowsingForPeers()
        headingTracker.start()
        statusText = "Searching for anchor..."
        print("[Mover] Browsing for anchor...")
    }

    func stop() {
        browser.stopBrowsingForPeers()
        mcSession.disconnect()
        niSession?.invalidate()
        niSession = nil
        headingTracker.stop()
        headingTimer?.invalidate()
        headingTimer = nil
        isConnectedToAnchor = false
    }

    /// The current heading from the compass (math convention).
    var heading: Double { headingTracker.heading }

    // MARK: - Send helpers

    private func send(_ msg: PeerMsg, to peer: MCPeerID) {
        guard let data = try? JSONEncoder().encode(msg) else { return }
        try? mcSession.send(data, toPeers: [peer], with: .reliable)
    }

    // MARK: - NI

    private func startNISession() {
        niSession = NISession()
        niSession?.delegate = self

        guard let token = niSession?.discoveryToken,
              let peer = anchorPeer else { return }

        // Send our token + camera_id to anchor
        guard let tokenData = try? NSKeyedArchiver.archivedData(
            withRootObject: token, requiringSecureCoding: true) else { return }

        send(PeerMsg(kind: .niToken, payload: tokenData.base64EncodedString()), to: peer)
        send(PeerMsg(kind: .cameraInfo, payload: cameraID), to: peer)
        print("[Mover] Sent NI token + camera_id to anchor")
    }

    private func handleAnchorToken(base64: String) {
        guard let tokenData = Data(base64Encoded: base64),
              let token = try? NSKeyedUnarchiver.unarchivedObject(
                ofClass: NIDiscoveryToken.self, from: tokenData) else {
            print("[Mover] Failed to decode anchor NI token")
            return
        }

        let config = NINearbyPeerConfiguration(peerToken: token)
        niSession?.run(config)
        print("[Mover] NI session running with anchor")
        DispatchQueue.main.async { self.statusText = "UWB session active" }
    }

    private func handlePositionUpdate(payload: String) {
        guard let data = payload.data(using: .utf8),
              let pos = try? JSONDecoder().decode([Double].self, from: data) else { return }
        DispatchQueue.main.async {
            self.position = pos
        }
    }

    // MARK: - Heading forwarding

    private func startHeadingForwarding() {
        headingTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            guard let self, let peer = self.anchorPeer else { return }
            let hdg = self.headingTracker.heading
            self.send(PeerMsg(kind: .headingUpdate, payload: String(hdg)), to: peer)
        }
    }

    // MARK: - Message dispatch

    fileprivate func handleMessage(_ data: Data, from peer: MCPeerID) {
        guard let msg = try? JSONDecoder().decode(PeerMsg.self, from: data) else { return }

        switch msg.kind {
        case .niToken:
            handleAnchorToken(base64: msg.payload)
        case .positionUpdate:
            handlePositionUpdate(payload: msg.payload)
        case .cameraInfo, .headingUpdate:
            break // mover doesn't receive these
        }
    }
}

// MARK: - MCSessionDelegate

extension MoverPeerClient: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID,
                 didChange state: MCSessionState) {
        DispatchQueue.main.async {
            switch state {
            case .connected:
                self.isConnectedToAnchor = true
                self.anchorPeer = peerID
                self.statusText = "Connected to anchor"
                print("[Mover] Connected to anchor: \(peerID.displayName)")
                // Send camera info and start NI
                self.send(PeerMsg(kind: .cameraInfo, payload: self.cameraID), to: peerID)
                self.startNISession()
                self.startHeadingForwarding()
            case .notConnected:
                self.isConnectedToAnchor = false
                self.anchorPeer = nil
                self.statusText = "Disconnected from anchor"
                self.niSession?.invalidate()
                self.niSession = nil
                self.headingTimer?.invalidate()
                print("[Mover] Disconnected from anchor")
            default:
                self.statusText = "Connecting..."
            }
        }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        handleMessage(data, from: peerID)
    }

    func session(_ s: MCSession, didReceive stream: InputStream, withName n: String, fromPeer p: MCPeerID) {}
    func session(_ s: MCSession, didStartReceivingResourceWithName n: String, fromPeer p: MCPeerID, with pr: Progress) {}
    func session(_ s: MCSession, didFinishReceivingResourceWithName n: String, fromPeer p: MCPeerID, at u: URL?, withError e: Error?) {}
}

// MARK: - MCNearbyServiceBrowserDelegate

extension MoverPeerClient: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser,
                 foundPeer peerID: MCPeerID,
                 withDiscoveryInfo info: [String: String]?) {
        // Auto-connect if it's an anchor
        if info?["role"] == "anchor" {
            print("[Mover] Found anchor: \(peerID.displayName), inviting...")
            browser.invitePeer(peerID, to: mcSession, withContext: nil, timeout: 10)
            DispatchQueue.main.async { self.statusText = "Found anchor, connecting..." }
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser,
                 lostPeer peerID: MCPeerID) {
        print("[Mover] Lost peer: \(peerID.displayName)")
    }
}

// MARK: - NISessionDelegate

extension MoverPeerClient: NISessionDelegate {
    func session(_ session: NISession, didUpdate nearbyObjects: [NINearbyObject]) {
        guard let obj = nearbyObjects.first else { return }
        DispatchQueue.main.async {
            self.distanceToAnchor = obj.distance
            if let d = obj.distance {
                self.statusText = String(format: "UWB active — %.2fm from anchor", d)
            }
        }
    }

    func session(_ session: NISession, didRemove nearbyObjects: [NINearbyObject],
                 reason: NINearbyObject.RemovalReason) {
        DispatchQueue.main.async { self.statusText = "UWB peer removed" }
    }

    func sessionWasSuspended(_ session: NISession) {
        DispatchQueue.main.async { self.statusText = "UWB suspended" }
    }

    func sessionSuspensionEnded(_ session: NISession) {
        DispatchQueue.main.async { self.statusText = "UWB resumed" }
    }

    func session(_ session: NISession, didInvalidateWith error: Error) {
        DispatchQueue.main.async {
            self.statusText = "UWB error: \(error.localizedDescription)"
        }
    }
}
