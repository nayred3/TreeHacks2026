# PhoneCamStream

iOS app that turns iPhones into networked camera sensors for the TreeHacks fusion system.

## What it does

Each iPhone running this app:
1. **Streams camera video** (JPEG frames via HTTP POST) to **Logan's Mac** (`10.35.2.131:5050`) for YOLO person detection
2. **Sends position + heading** (UDP JSON) to **Justin's Mac** (`10.35.6.219:5056`) for the spatial fusion/mapping engine

A **central phone** sits in the middle of the room as the origin `(0, 0)`. All other phones report their position relative to it.

## Architecture

```
┌──────────────┐    JPEG frames (HTTP POST)     ┌─────────────────┐
│  iPhone #1   │ ────────────────────────────▶   │  Logan's Mac    │
│  iPhone #2   │ ────────────────────────────▶   │  10.35.2.131    │
│  iPhone #N   │ ────────────────────────────▶   │  (YOLO detect)  │
└──────┬───────┘                                 └────────┬────────┘
       │                                                  │
       │  position + heading (UDP JSON)                   │ detections
       ▼                                                  ▼
┌─────────────────┐                              ┌─────────────────┐
│  Justin's Mac   │ ◀───────────────────────────│  (forwarded)    │
│  10.35.6.219    │                              └─────────────────┘
│  (Fusion Map)   │
└─────────────────┘
```

## Prerequisites

- **All devices on the same WiFi** (Stanford WiFi)
- iPhones running iOS 16+ with camera + compass
- Xcode 15+ to build the app
- Python 3.8+ on both Macs (for receiver scripts)
- `flask` pip package on Logan's Mac

## Quick Start

### 1. Generate the Xcode project

Install [XcodeGen](https://github.com/yonaskolb/XcodeGen) if you don't have it:

```bash
brew install xcodegen
```

Then generate & open the project:

```bash
cd phonecamstream
xcodegen generate
open PhoneCamStream.xcodeproj
```

**Or create manually in Xcode:**
1. File → New → Project → iOS App (SwiftUI, Swift)
2. Name it `PhoneCamStream`, bundle ID `com.treehacks.PhoneCamStream`
3. Delete the auto-generated files, drag in all `.swift` files from `PhoneCamStream/`
4. Set the Info.plist path in Build Settings
5. Set deployment target to iOS 16.0

### 2. Build & run on iPhone

- Select your iPhone as the build target
- Set your Development Team in Signing & Capabilities
- Build & Run (⌘R)
- The phone will ask for Camera and Location permissions → Allow

### 3. Start receiver on Logan's Mac

```bash
pip install flask
cd phonecamstream
python frame_receiver.py
```

This listens on port 5050 and saves the latest frame per camera to `received_frames/`.

### 4. Start receiver on Justin's Mac

```bash
cd phonecamstream
python position_receiver.py
```

This listens on UDP port 5056 for position/heading JSON packets.

### 5. Configure the iPhone app

On each camera iPhone:
1. Set a unique **Camera ID** (e.g. `phone_1`, `phone_2`)
2. Enter the phone's **position** in metres relative to the central phone:
   - X = metres East of center (positive = East)
   - Y = metres North of center (positive = North)
3. Verify the target IPs and ports
4. Tap **Start Streaming**

## Data Formats

### Video frames (iPhone → Logan's Mac)

```
POST http://10.35.2.131:5050/frame
Headers:
  Content-Type: image/jpeg
  X-Camera-Id: phone_1
  X-Timestamp: 1700000000.123
Body: <raw JPEG bytes>
```

### Position data (iPhone → Justin's Mac)

UDP JSON to port 5056:

```json
{
    "type": "camera_state",
    "camera_id": "phone_1",
    "position": [3.0, 2.0],
    "heading": 45.0,
    "timestamp": 1700000000.123
}
```

This matches the `CameraState` schema in `fusion/schemas.py`.

### Heading Convention

The heading is sent in **math convention** (used by the fusion engine):
- 0° = facing +x (East)
- 90° = facing +y (North)
- 180° = facing −x (West)
- 270° = facing −y (South)

The app automatically converts from iPhone compass (0° = North, clockwise) to this convention.

## Coordinate System

```
        North (+y)
           ▲
           │
           │
West ◀─────●─────▶ East (+x)
     (-x)  │  central
           │  phone
           ▼
        South (-y)
```

Place the central phone at the origin. Measure each camera phone's position
in metres East (X) and North (Y) from the central phone.

## Troubleshooting

- **"Frame send failed"**: Check that Logan's Mac is running `frame_receiver.py` and the IP/port are correct
- **No heading data**: Make sure Location permission is granted and you're on a real device (simulator has no compass)
- **Can't connect**: Verify all devices are on the same WiFi network
- **Frames are slow**: Lower the JPEG quality or FPS in the setup screen
