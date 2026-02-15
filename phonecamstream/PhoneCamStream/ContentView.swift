import SwiftUI

// MARK: - App Configuration

class AppConfig: ObservableObject {
    @Published var cameraID: String = "phone_1"
    @Published var positionX: String = "0.0"
    @Published var positionY: String = "0.0"

    // Video frames (YOLO detection)
    @Published var loganIP: String = "10.35.6.219"
    @Published var loganPort: String = "5050"

    // Position/heading data (mapping)
    @Published var justinIP: String = "10.35.6.219"
    @Published var justinPort: String = "5056"

    // Stream quality
    @Published var streamFPS: Double = 5
    @Published var jpegQuality: Double = 0.5

    // Derived helpers
    var posX: Double { Double(positionX) ?? 0.0 }
    var posY: Double { Double(positionY) ?? 0.0 }
    var loganPortInt: UInt16 { UInt16(loganPort) ?? 5050 }
    var justinPortInt: UInt16 { UInt16(justinPort) ?? 5056 }
}

// MARK: - App Phase

enum AppPhase {
    case roleSelection
    case anchorRunning
    case cameraSetup
    case cameraStreaming
}

// MARK: - Root View

struct ContentView: View {
    @StateObject private var config = AppConfig()
    @State private var phase: AppPhase = .roleSelection

    var body: some View {
        NavigationStack {
            switch phase {
            case .roleSelection:
                RoleSelectionView(config: config,
                    onAnchor: { phase = .anchorRunning },
                    onCamera: { phase = .cameraSetup })

            case .anchorRunning:
                AnchorView(config: config, onStop: { phase = .roleSelection })

            case .cameraSetup:
                SetupView(config: config, onStart: { phase = .cameraStreaming })

            case .cameraStreaming:
                StreamingView(config: config, onStop: { phase = .cameraSetup })
            }
        }
    }
}

// MARK: - Role Selection

struct RoleSelectionView: View {
    @ObservedObject var config: AppConfig
    var onAnchor: () -> Void
    var onCamera: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            Image(systemName: "video.fill")
                .font(.system(size: 50))
                .foregroundColor(.blue)
            Text("PhoneCamStream")
                .font(.largeTitle.bold())
            Text("Select this phone's role")
                .foregroundColor(.secondary)

            Spacer()

            // Anchor button
            Button(action: onAnchor) {
                VStack(spacing: 6) {
                    Image(systemName: "antenna.radiowaves.left.and.right")
                        .font(.title)
                    Text("Anchor Phone")
                        .font(.headline)
                    Text("Place in the center of the room.\nComputes positions for all cameras via UWB.")
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(.blue)
                .foregroundColor(.white)
                .cornerRadius(16)
            }

            // Camera button
            Button(action: onCamera) {
                VStack(spacing: 6) {
                    Image(systemName: "camera.fill")
                        .font(.title)
                    Text("Camera Phone")
                        .font(.headline)
                    Text("Streams video to Logan's Mac.\nPosition tracked via UWB from anchor.")
                        .font(.caption)
                        .foregroundColor(.white.opacity(0.8))
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(.green)
                .foregroundColor(.white)
                .cornerRadius(16)
            }

            Spacer()

            // Network settings (shared)
            GroupBox("Network") {
                VStack(spacing: 8) {
                    HStack {
                        Text("Position data")
                            .font(.caption)
                        Spacer()
                        TextField("10.35.6.219", text: $config.justinIP)
                            .font(.caption.monospaced())
                            .multilineTextAlignment(.trailing)
                            .frame(width: 130)
                        Text(":")
                            .font(.caption)
                        TextField("5056", text: $config.justinPort)
                            .font(.caption.monospaced())
                            .frame(width: 50)
                    }
                    HStack {
                        Text("Video frames")
                            .font(.caption)
                        Spacer()
                        TextField("10.35.6.219", text: $config.loganIP)
                            .font(.caption.monospaced())
                            .multilineTextAlignment(.trailing)
                            .frame(width: 130)
                        Text(":")
                            .font(.caption)
                        TextField("5050", text: $config.loganPort)
                            .font(.caption.monospaced())
                            .frame(width: 50)
                    }
                }
            }
            .padding(.horizontal)
        }
        .padding()
    }
}

// MARK: - Camera Setup View

struct SetupView: View {
    @ObservedObject var config: AppConfig
    var onStart: () -> Void

    var body: some View {
        Form {
            Section("Camera Identity") {
                HStack {
                    Text("Camera ID")
                    Spacer()
                    TextField("phone_1", text: $config.cameraID)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
            }

            Section("Fallback Position (if no UWB)") {
                HStack {
                    Text("X (East +)")
                    Spacer()
                    TextField("0.0", text: $config.positionX)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
                HStack {
                    Text("Y (North +)")
                    Spacer()
                    TextField("0.0", text: $config.positionY)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                }
            }

            Section("Stream Settings") {
                VStack(alignment: .leading) {
                    Text("Frame Rate: \(Int(config.streamFPS)) FPS")
                    Slider(value: $config.streamFPS, in: 1...15, step: 1)
                }
                VStack(alignment: .leading) {
                    Text("JPEG Quality: \(Int(config.jpegQuality * 100))%")
                    Slider(value: $config.jpegQuality, in: 0.1...1.0, step: 0.1)
                }
            }

            Section {
                Button(action: onStart) {
                    HStack {
                        Spacer()
                        Label("Start Streaming", systemImage: "video.fill")
                            .font(.headline)
                        Spacer()
                    }
                }
                .listRowBackground(Color.green)
                .foregroundColor(.white)
            }
        }
        .navigationTitle("Camera Setup")
    }
}
