import SwiftUI

struct AnchorView: View {
    @ObservedObject var config: AppConfig
    var onStop: () -> Void

    @StateObject private var anchor = AnchorManager()
    @StateObject private var positionSender = PositionSender()

    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 4) {
                Image(systemName: "antenna.radiowaves.left.and.right")
                    .font(.system(size: 44))
                    .foregroundColor(.blue)
                Text("Anchor Phone")
                    .font(.title2.bold())
                Text("Central reference point (0, 0)")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
            .padding(.top, 20)

            // Status
            HStack {
                Circle()
                    .fill(anchor.isAdvertising ? .green : .red)
                    .frame(width: 10, height: 10)
                Text(anchor.isAdvertising ? "Advertising" : "Stopped")
                    .font(.subheadline)
                Spacer()
                Text("\(anchor.connectedCount) movers connected")
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }
            .padding()
            .background(Color(.systemGroupedBackground))
            .cornerRadius(10)
            .padding(.horizontal)
            .padding(.top, 12)

            // Compass heading
            HStack {
                Image(systemName: "location.north.fill")
                    .rotationEffect(.degrees(-anchor.anchorHeading))
                Text("Anchor heading: \(anchor.anchorHeading, specifier: "%.0f")°")
                    .font(.caption.monospaced())
                Spacer()
            }
            .padding(.horizontal)
            .padding(.top, 8)

            // Connected movers list
            List {
                if anchor.movers.isEmpty {
                    HStack {
                        ProgressView()
                            .padding(.trailing, 8)
                        Text("Waiting for camera phones to connect...")
                            .foregroundColor(.secondary)
                    }
                } else {
                    ForEach(Array(anchor.movers.values).sorted(by: { $0.id < $1.id })) { mover in
                        MoverRow(mover: mover)
                    }
                }
            }
            .listStyle(.insetGrouped)

            // Position sender to Justin's Mac
            HStack {
                Circle()
                    .fill(positionSender.isConnected ? .green : .red)
                    .frame(width: 8, height: 8)
                Text("UDP → Justin (\(config.justinIP):\(config.justinPort))")
                    .font(.caption2)
                Spacer()
            }
            .padding(.horizontal)
            .padding(.bottom, 4)

            // Stop button
            Button(action: stopAnchor) {
                Label("Stop Anchor", systemImage: "stop.fill")
                    .font(.headline)
                    .padding()
                    .frame(maxWidth: .infinity)
                    .background(.red)
                    .foregroundColor(.white)
                    .cornerRadius(12)
            }
            .padding()
        }
        .onAppear(perform: startAnchor)
        .onDisappear { anchor.stop() }
        .navigationTitle("Anchor")
        .navigationBarBackButtonHidden(true)
    }

    private func startAnchor() {
        // Configure position sender to Justin's Mac
        positionSender.configure(
            targetHost: config.justinIP,
            targetPort: config.justinPortInt,
            cameraID: "anchor"
        )
        anchor.positionSender = positionSender
        anchor.start()
    }

    private func stopAnchor() {
        anchor.stop()
        positionSender.stop()
        onStop()
    }
}

// MARK: - Mover Row

struct MoverRow: View {
    let mover: MoverData

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Image(systemName: "camera.fill")
                    .foregroundColor(.blue)
                Text(mover.id)
                    .font(.headline.monospaced())
                Spacer()
                if let d = mover.distance {
                    Text(String(format: "%.2fm", d))
                        .font(.caption.monospaced())
                        .foregroundColor(.orange)
                }
            }

            HStack {
                Text("pos: (\(mover.position[0], specifier: "%.2f"), \(mover.position[1], specifier: "%.2f"))")
                    .font(.caption2.monospaced())
                Spacer()
                Text("heading: \(mover.heading, specifier: "%.0f")°")
                    .font(.caption2.monospaced())
            }
            .foregroundColor(.secondary)

            if mover.direction != nil {
                HStack {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(.green)
                        .font(.caption2)
                    Text("UWB direction available")
                        .font(.caption2)
                        .foregroundColor(.green)
                }
            } else if mover.distance != nil {
                HStack {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(.yellow)
                        .font(.caption2)
                    Text("Distance only (no direction)")
                        .font(.caption2)
                        .foregroundColor(.yellow)
                }
            }
        }
        .padding(.vertical, 4)
    }
}
