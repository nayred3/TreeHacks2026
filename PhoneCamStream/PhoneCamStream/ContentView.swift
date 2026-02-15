import SwiftUI
import AVFoundation
import Network
import CoreMotion
import UIKit
import Combine

// MARK: - App UI

struct ContentView: View {
    @StateObject private var controller = PhoneCamController()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("iPhone Camera Stream + Yaw UDP")
                .font(.title2)
                .bold()

            Group {
                HStack {
                    Text("camera_id:")
                    TextField("camA", text: $controller.cameraID)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 160)
                }

                HStack {
                    Text("HTTP port:")
                    TextField("8080", text: $controller.httpPortString)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(maxWidth: 120)
                }

                HStack {
                    Text("Fusion UDP:")
                    TextField("10.35.6.219", text: $controller.fusionHost)
                        .textFieldStyle(.roundedBorder)
                        .frame(maxWidth: 220)

                    TextField("5055", text: $controller.fusionPortString)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(maxWidth: 90)
                }

                HStack {
                    Text("Rel pos (m):")
                    TextField("x", text: $controller.relXString)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numbersAndPunctuation)
                        .frame(maxWidth: 90)
                    TextField("y", text: $controller.relYString)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numbersAndPunctuation)
                        .frame(maxWidth: 90)
                    Text("wrt center phone")
                        .foregroundStyle(.secondary)
                }

                HStack {
                    Text("JPEG FPS:")
                    TextField("12", text: $controller.jpegFpsString)
                        .textFieldStyle(.roundedBorder)
                        .keyboardType(.numberPad)
                        .frame(maxWidth: 90)

                    Text("Quality:")
                    Slider(value: $controller.jpegQuality, in: 0.2...0.95)
                        .frame(maxWidth: 180)
                    Text(String(format: "%.2f", controller.jpegQuality))
                        .monospacedDigit()
                }

                Toggle("Send yaw over UDP", isOn: $controller.sendYawUDP)
                Toggle("Use back camera", isOn: $controller.useBackCamera)
            }

            Divider()

            Group {
                Text("Status:")
                    .bold()
                Text(controller.statusText)
                    .font(.system(.body, design: .monospaced))
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let url = controller.streamURLString {
                    Text("Stream URL:")
                        .bold()
                    Text(url)
                        .font(.system(.body, design: .monospaced))
                        .textSelection(.enabled)
                }
            }

            HStack(spacing: 12) {
                Button(controller.isRunning ? "Stop" : "Start") {
                    if controller.isRunning {
                        controller.stop()
                    } else {
                        controller.start()
                    }
                }
                .buttonStyle(.borderedProminent)

                Button("Calibrate Yaw Zero") {
                    controller.calibrateYaw()
                }
                .buttonStyle(.bordered)

                Spacer()
            }

            Text("Mac OpenCV: cv2.VideoCapture(\"http://IPHONE_IP:PORT/stream\")")
                .font(.footnote)
                .foregroundStyle(.secondary)
            
            Text("UDP JSON: {type:'pose', camera_id, yaw_deg, rel_x_m, rel_y_m}")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .padding()
        .onDisappear {
            controller.stop()
        }
    }
}

// MARK: - Controller (ties together camera + MJPEG server + yaw UDP)

final class PhoneCamController: ObservableObject {
    // UI-configurable
    @Published var cameraID: String = "camA"
    @Published var httpPortString: String = "8080"
    @Published var fusionHost: String = "10.35.6.219"
    @Published var fusionPortString: String = "5055"
    @Published var jpegFpsString: String = "12"
    @Published var jpegQuality: Double = 0.75
    @Published var sendYawUDP: Bool = true
    @Published var useBackCamera: Bool = true
    @Published var relXString: String = "0.0"
    @Published var relYString: String = "0.0"

    // Status
    @Published var isRunning: Bool = false
    @Published var statusText: String = "Idle"
    @Published var streamURLString: String? = nil
    
    private let camera = CameraFrameSource()
    private let motion = MotionYawSource()
    private var mjpegServer: MJPEGServer?
    private var udpYaw: UDPYawSender?

    private var yawZeroOffsetRad: Double = 0.0
    private var lastSentPos: (x: Double, y: Double)? = nil

    func start() {
        guard let port = UInt16(httpPortString),
              let fusionPort = UInt16(fusionPortString) else {
            statusText = "Invalid port(s)."
            return
        }

        isRunning = true
        statusText = "Starting..."

        // 1) Start camera capture
        camera.start(useBackCamera: useBackCamera) { [weak self] jpegData in
            guard let self else { return }
            self.mjpegServer?.updateJPEG(jpegData)
        } jpegConfig: { [weak self] in
            guard let self else { return (12, 0.75) }
            let fps = max(1, min(30, Int(self.jpegFpsString) ?? 12))
            let q = Float(self.jpegQuality)
            return (fps, q)
        }

        // 2) Start MJPEG server
        let server = MJPEGServer(port: port)
        server.onLog = { [weak self] s in
            DispatchQueue.main.async {
                self?.statusText = s
            }
        }
        server.start()
        self.mjpegServer = server

        // 3) Start motion yaw
        motion.start { [weak self] yawRad in
            guard let self else { return }
            // Convert to calibrated yaw
            let yawCal = normalizeAngleRad(yawRad - self.yawZeroOffsetRad)
            if self.sendYawUDP {
                // Parse relative position from UI (meters). If invalid, default to 0.
                let x = Double(self.relXString) ?? 0.0
                let y = Double(self.relYString) ?? 0.0
                self.udpYaw?.sendPose(cameraID: self.cameraID, yawRad: yawCal, yawRawRad: yawRad, relX: x, relY: y)
            }
        }

        // 4) Start UDP yaw sender
        let udp = UDPYawSender(host: fusionHost, port: fusionPort)
        udp.start()
        self.udpYaw = udp

        // 5) Show stream URL
        if let ip = LocalIP.bestEffortWiFiIP() {
            streamURLString = "http://\(ip):\(port)/stream"
        } else {
            streamURLString = "http://<iphone_ip>:\(port)/stream"
        }

        statusText = "Running. MJPEG :\(port), UDP pose -> \(fusionHost):\(fusionPort)"
    }

    func stop() {
        isRunning = false
        camera.stop()
        motion.stop()
        mjpegServer?.stop()
        udpYaw?.stop()
        mjpegServer = nil
        udpYaw = nil
        statusText = "Stopped."
    }

    func calibrateYaw() {
        // Set current yaw as zero reference.
        if let cur = motion.latestYawRad {
            yawZeroOffsetRad = cur
            statusText = "Yaw calibrated."
        } else {
            statusText = "Yaw not available yet."
        }
    }
}

// MARK: - Camera capture -> JPEG frames

final class CameraFrameSource: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let queue = DispatchQueue(label: "cam.frames.queue")
    private var onJPEG: ((Data) -> Void)?
    private var jpegConfig: (() -> (fps: Int, quality: Float))?

    private var lastEmitTime: CFTimeInterval = 0

    func start(useBackCamera: Bool,
               onJPEG: @escaping (Data) -> Void,
               jpegConfig: @escaping () -> (fps: Int, quality: Float)) {
        self.onJPEG = onJPEG
        self.jpegConfig = jpegConfig

        session.beginConfiguration()
        session.sessionPreset = .vga640x480

        // Input
        session.inputs.forEach { session.removeInput($0) }
        let position: AVCaptureDevice.Position = useBackCamera ? .back : .front
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            print("Could not create camera input.")
            session.commitConfiguration()
            return
        }
        session.addInput(input)

        // Output
        output.setSampleBufferDelegate(self, queue: queue)
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]

        session.outputs.forEach { session.removeOutput($0) }
        guard session.canAddOutput(output) else {
            print("Could not add video output.")
            session.commitConfiguration()
            return
        }
        session.addOutput(output)

        if let conn = output.connection(with: .video) {
            if #available(iOS 17.0, *) {
                // Rotate to portrait (90°) if supported on iOS 17+
                if conn.isVideoRotationAngleSupported(90) {
                    conn.videoRotationAngle = 90
                }
            } else {
                // Fallback for earlier iOS versions
                conn.videoOrientation = .portrait
            }
        }

        session.commitConfiguration()
        session.startRunning()
    }

    func stop() {
        session.stopRunning()
        onJPEG = nil
        jpegConfig = nil
    }

    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {

        guard let cfg = jpegConfig else { return }
        let (fps, quality) = cfg()
        let minDt = 1.0 / Double(max(1, fps))

        let now = CACurrentMediaTime()
        if now - lastEmitTime < minDt { return }
        lastEmitTime = now

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }

        // Convert CVPixelBuffer -> JPEG
        // NOTE: For speed, CIContext reuse would be better; this is hackathon-simple.
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let context = CIContext()
        guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else { return }
        let uiImage = UIImage(cgImage: cgImage)

        guard let jpegData = uiImage.jpegData(compressionQuality: CGFloat(quality)) else { return }
        onJPEG?(jpegData)
    }
}

// MARK: - MJPEG HTTP Server (very small, minimal parsing)

final class MJPEGServer {
    let port: UInt16
    var onLog: ((String) -> Void)?

    private var listener: NWListener?
    private let serverQueue = DispatchQueue(label: "mjpeg.server.queue")

    private let jpegLock = DispatchQueue(label: "mjpeg.jpeg.lock")
    private var latestJPEG: Data? = nil

    init(port: UInt16) {
        self.port = port
    }

    func start() {
        do {
            let params = NWParameters.tcp
            let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
            self.listener = listener

            listener.newConnectionHandler = { [weak self] conn in
                self?.handle(connection: conn)
            }

            listener.stateUpdateHandler = { [weak self] state in
                self?.onLog?("MJPEG listener state: \(state)")
            }

            listener.start(queue: serverQueue)
            onLog?("MJPEG server listening on port \(port)")
        } catch {
            onLog?("Failed to start MJPEG server: \(error)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    func updateJPEG(_ data: Data) {
        jpegLock.async { [weak self] in
            self?.latestJPEG = data
        }
    }

    private func handle(connection: NWConnection) {
        connection.start(queue: serverQueue)

        // Read the HTTP request (we only need the first line + headers end)
        receiveRequestHeaders(connection: connection) { [weak self] request in
            guard let self else { return }
            // Very minimal routing: accept /stream, otherwise 404
            if request.contains("GET /stream") {
                self.sendMJPEGStream(connection: connection)
            } else {
                self.sendNotFound(connection: connection)
            }
        }
    }

    private func receiveRequestHeaders(connection: NWConnection, completion: @escaping (String) -> Void) {
        var buffer = Data()

        func receiveMore() {
            connection.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, isComplete, error in
                if let data { buffer.append(data) }

                if let error {
                    self.onLog?("HTTP recv error: \(error)")
                    connection.cancel()
                    return
                }
                if isComplete {
                    completion(String(decoding: buffer, as: UTF8.self))
                    return
                }

                // End of headers: \r\n\r\n
                if buffer.range(of: Data([13,10,13,10])) != nil {
                    completion(String(decoding: buffer, as: UTF8.self))
                    return
                }
                receiveMore()
            }
        }
        receiveMore()
    }

    private func sendNotFound(connection: NWConnection) {
        let body = "Not Found"
        let resp = """
        HTTP/1.1 404 Not Found\r
        Content-Length: \(body.utf8.count)\r
        Content-Type: text/plain\r
        Connection: close\r
        \r
        \(body)
        """
        connection.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in
            connection.cancel()
        })
    }

    private func sendMJPEGStream(connection: NWConnection) {
        // MJPEG multipart response
        let boundary = "mjpeg-boundary"
        let header = """
        HTTP/1.1 200 OK\r
        Cache-Control: no-cache\r
        Pragma: no-cache\r
        Connection: close\r
        Content-Type: multipart/x-mixed-replace; boundary=\(boundary)\r
        \r
        """

        connection.send(content: header.data(using: .utf8), completion: .contentProcessed { _ in })

        onLog?("Client connected to /stream")

        // Stream loop: send latest JPEG repeatedly
        streamLoop(connection: connection, boundary: boundary)
    }

    private func streamLoop(connection: NWConnection, boundary: String) {
        // Adjust for latency/bandwidth
        let frameInterval: TimeInterval = 1.0 / 12.0  // you can tune; phones will also cap FPS upstream

        func tick() {
            jpegLock.async { [weak self] in
                guard let self else { return }
                guard let jpeg = self.latestJPEG else {
                    // try again soon
                    self.serverQueue.asyncAfter(deadline: .now() + 0.05) { tick() }
                    return
                }

                let partHeader = """
                --\(boundary)\r
                Content-Type: image/jpeg\r
                Content-Length: \(jpeg.count)\r
                \r
                """

                var payload = Data()
                payload.append(partHeader.data(using: .utf8)!)
                payload.append(jpeg)
                payload.append("\r\n".data(using: .utf8)!)

                connection.send(content: payload, completion: .contentProcessed { sendError in
                    if sendError != nil {
                        self.onLog?("Stream send ended: \(String(describing: sendError))")
                        connection.cancel()
                        return
                    }
                    self.serverQueue.asyncAfter(deadline: .now() + frameInterval) { tick() }
                })
            }
        }

        tick()
    }
}

// MARK: - Yaw source (Core Motion)

final class MotionYawSource {
    private let mgr = CMMotionManager()
    private let q = OperationQueue()
    var latestYawRad: Double? = nil

    func start(onYaw: @escaping (Double) -> Void) {
        guard mgr.isDeviceMotionAvailable else { return }
        mgr.deviceMotionUpdateInterval = 1.0 / 60.0

        // Use a gravity-aligned reference frame (no magnetometer reliance)
        let frame: CMAttitudeReferenceFrame = .xArbitraryZVertical

        mgr.startDeviceMotionUpdates(using: frame, to: q) { [weak self] motion, err in
            guard let self else { return }
            guard let motion else { return }

            let yaw = motion.attitude.yaw  // radians
            self.latestYawRad = yaw
            onYaw(yaw)
        }
    }

    func stop() {
        mgr.stopDeviceMotionUpdates()
        latestYawRad = nil
    }
}

// MARK: - UDP yaw sender

final class UDPYawSender {
    private let host: NWEndpoint.Host
    private let port: NWEndpoint.Port
    private var conn: NWConnection?

    init(host: String, port: UInt16) {
        self.host = NWEndpoint.Host(host)
        self.port = NWEndpoint.Port(rawValue: port)!
    }

    func start() {
        let c = NWConnection(host: host, port: port, using: .udp)
        self.conn = c
        c.start(queue: .global())
    }

    func stop() {
        conn?.cancel()
        conn = nil
    }

    func sendYaw(cameraID: String, yawRad: Double, yawRawRad: Double) {
        guard let conn else { return }

        // Minimal JSON payload your Mac can consume
        let msg: [String: Any] = [
            "type": "yaw",
            "camera_id": cameraID,
            "timestamp_s": Date().timeIntervalSince1970,
            "yaw_deg": yawRad * 180.0 / Double.pi,
            "yaw_raw_deg": yawRawRad * 180.0 / Double.pi
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: msg, options: []) else { return }
        conn.send(content: data, completion: .contentProcessed { _ in })
    }
    
    func sendPose(cameraID: String, yawRad: Double, yawRawRad: Double, relX: Double, relY: Double) {
        guard let conn else { return }
        let msg: [String: Any] = [
            "type": "pose",
            "camera_id": cameraID,
            "timestamp_s": Date().timeIntervalSince1970,
            "yaw_deg": yawRad * 180.0 / Double.pi,
            "yaw_raw_deg": yawRawRad * 180.0 / Double.pi,
            "rel_x_m": relX,
            "rel_y_m": relY
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: msg, options: []) else { return }
        conn.send(content: data, completion: .contentProcessed { _ in })
    }
}

// MARK: - Utilities

func normalizeAngleRad(_ a: Double) -> Double {
    var x = a
    while x > Double.pi { x -= 2 * Double.pi }
    while x < -Double.pi { x += 2 * Double.pi }
    return x
}

// Best-effort local Wi-Fi IP (for display only)
enum LocalIP {
    static func bestEffortWiFiIP() -> String? {
        var address: String?
        var ifaddr: UnsafeMutablePointer<ifaddrs>? = nil
        guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return nil }
        defer { freeifaddrs(ifaddr) }

        for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
            let interface = ptr.pointee
            let addrFamily = interface.ifa_addr.pointee.sa_family

            // AF_INET only
            if addrFamily == UInt8(AF_INET) {
                let name = String(cString: interface.ifa_name)
                // "en0" is usually Wi-Fi
                if name == "en0" {
                    var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
                    getnameinfo(interface.ifa_addr, socklen_t(interface.ifa_addr.pointee.sa_len),
                                &hostname, socklen_t(hostname.count),
                                nil, socklen_t(0), NI_NUMERICHOST)
                    address = String(cString: hostname)
                    break
                }
            }
        }
        return address
    }
}
