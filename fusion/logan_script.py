import socket, json

PORT = 5055

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.bind(("0.0.0.0", PORT))  # listen on all interfaces

print(f"Listening for UDP on port {PORT}...")
while True:
    data, addr = sock.recvfrom(65535)  # max UDP packet size to read
    try:
        msg = json.loads(data.decode("utf-8"))
    except Exception as e:
        print("Bad packet from", addr, "error:", e)
        continue

    print("From", addr, "type:", msg.get("type"), "camera:", msg.get("camera_id"))
    # msg["detections"] is where your bboxes are (for type == "tracks")