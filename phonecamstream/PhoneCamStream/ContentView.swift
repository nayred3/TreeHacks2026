import SwiftUI

// MARK: - App Configuration

class AppConfig: ObservableObject {
    @Published var cameraID: String = "phone_1"
    @Published var positionX: String = "0.0"
    @Published var positionY: String = "0.0"

    // Logan's Mac – receives video frames for YOLO
    @Published var loganIP: String = "10.35.2.131"
    @Published var loganPort: String = "5050"

    // Justin's Mac – receives position/heading data for mapping
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

// MARK: - Root View

struct ContentView: View {
    @StateObject private var config = AppConfig()
    @State private var isStreaming = false

    var body: some View {
        NavigationStack {
            if isStreaming {
                StreamingView(config: config, onStop: { isStreaming = false })
            } else {
                SetupView(config: config, onStart: { isStreaming = true })
            }
        }
    }
}

// MARK: - Setup View

struct SetupView: View {
    @ObservedObject var config: AppConfig
    var onStart: () -> Void

    var body: some View {
        Form {
            Section {
                VStack(spacing: 4) {
                    Image(systemName: "video.fill")
                        .font(.system(size: 40))
                        .foregroundColor(.blue)
                    Text("PhoneCamStream")
                        .font(.title2.bold())
                    Text("Stream camera + position to the fusion server")
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }

            Section("Camera Identity") {
                HStack {
                    Text("Camera ID")
                    Spacer()
                    TextField("phone_1", text: $config.cameraID)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
            }

            Section("Position (metres from central phone)") {
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

            Section("Logan's Mac (Video Frames)") {
                HStack {
                    Text("IP Address")
                    Spacer()
                    TextField("10.35.2.131", text: $config.loganIP)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
                HStack {
                    Text("Port")
                    Spacer()
                    TextField("5050", text: $config.loganPort)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                }
            }

            Section("Justin's Mac (Position Data)") {
                HStack {
                    Text("IP Address")
                    Spacer()
                    TextField("10.35.6.219", text: $config.justinIP)
                        .keyboardType(.decimalPad)
                        .multilineTextAlignment(.trailing)
                        .autocorrectionDisabled()
                }
                HStack {
                    Text("Port")
                    Spacer()
                    TextField("5056", text: $config.justinPort)
                        .keyboardType(.numberPad)
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
        .navigationTitle("Setup")
    }
}
