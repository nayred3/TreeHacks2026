import Foundation
import Network

/// Sends camera position and heading to Justin's Mac via UDP JSON packets.
///
/// Packet format (matches `CameraState` in fusion/schemas.py):
/// ```json
/// {
///   "type":       "camera_state",
///   "camera_id":  "phone_1",
///   "position":   [x, y],          // metres from central phone
///   "heading":    123.4,            // degrees, math convention (0 = +x/East, 90 = +y/North)
///   "timestamp":  1700000000.123    // Unix seconds
/// }
/// ```
class PositionSender: ObservableObject {

    @Published var isConnected = false
    private(set) var isConfigured = false

    // MARK: - Private

    private var connection: NWConnection?
    private var cameraID: String = ""

    // MARK: - Public API

    func configure(targetHost: String, targetPort: UInt16, cameraID: String) {
        self.cameraID = cameraID

        let host = NWEndpoint.Host(targetHost)
        guard let port = NWEndpoint.Port(rawValue: targetPort) else {
            print("[PositionSender] Invalid port \(targetPort)")
            return
        }

        connection = NWConnection(host: host, port: port, using: .udp)

        connection?.stateUpdateHandler = { [weak self] state in
            DispatchQueue.main.async {
                switch state {
                case .ready:
                    self?.isConnected = true
                case .failed, .cancelled:
                    self?.isConnected = false
                default:
                    break
                }
            }
        }

        connection?.start(queue: .global(qos: .userInitiated))
        isConfigured = true
    }

    func sendPosition(
        position: [Double],
        heading: Double,
        completion: ((Bool) -> Void)? = nil
    ) {
        guard let connection else {
            completion?(false)
            return
        }

        let payload: [String: Any] = [
            "type":       "camera_state",
            "camera_id":  cameraID,
            "position":   position,
            "heading":    heading,
            "timestamp":  Date().timeIntervalSince1970,
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
            completion?(false)
            return
        }

        connection.send(content: data, completion: .contentProcessed { error in
            let ok = error == nil
            DispatchQueue.main.async {
                completion?(ok)
            }
        })
    }

    func stop() {
        connection?.cancel()
        connection = nil
        isConfigured = false
        DispatchQueue.main.async { self.isConnected = false }
    }
}
