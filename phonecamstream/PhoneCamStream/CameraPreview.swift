import SwiftUI
import ARKit
import SceneKit

/// SwiftUI wrapper around ARSCNView — shows the live camera feed
/// from the ARSession with no 3D content overlay.
struct ARCameraPreview: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView()
        view.session = session
        view.scene = SCNScene()                    // empty scene = camera only
        view.automaticallyUpdatesLighting = false
        view.debugOptions = []                     // no debug overlays
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {
        // ARSCNView auto-updates from the session.
    }
}
