import CoreLocation

/// Provides the device's compass heading, converted to the math convention
/// used by the fusion engine:
///   0°   = facing +x (East)
///   90°  = facing +y (North)
///   180° = facing −x (West)
///   270° = facing −y (South)
///
/// The raw iPhone compass gives 0 = North, 90 = East (clockwise).
/// Conversion: mathHeading = (90 − compassHeading + 360) mod 360
class HeadingTracker: NSObject, ObservableObject, CLLocationManagerDelegate {

    /// Heading in the math convention (degrees), suitable for `CameraState.heading`.
    @Published var heading: Double = 0

    /// Raw compass heading (0 = N, 90 = E).
    @Published var compassHeading: Double = 0

    @Published var hasPermission = false

    private let manager = CLLocationManager()

    override init() {
        super.init()
        manager.delegate = self
        manager.headingFilter = 1          // update every 1° change
    }

    func start() {
        manager.requestWhenInUseAuthorization()
        if CLLocationManager.headingAvailable() {
            manager.startUpdatingHeading()
        } else {
            print("[HeadingTracker] Heading not available on this device")
        }
    }

    func stop() {
        manager.stopUpdatingHeading()
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        let raw = newHeading.trueHeading >= 0
            ? newHeading.trueHeading
            : newHeading.magneticHeading

        let math = (90 - raw + 360).truncatingRemainder(dividingBy: 360)

        DispatchQueue.main.async {
            self.compassHeading = raw
            self.heading = math
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus
        DispatchQueue.main.async {
            self.hasPermission = (status == .authorizedWhenInUse || status == .authorizedAlways)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        print("[HeadingTracker] Error: \(error.localizedDescription)")
    }
}
