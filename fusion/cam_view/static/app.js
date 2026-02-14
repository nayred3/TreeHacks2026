(function () {
  "use strict";

  // ────────────────────────────────────────────────
  //  Constants
  // ────────────────────────────────────────────────
  var FEED_W = 640, FEED_H = 480;          // simulated camera image dims
  var MAP_W = 600, MAP_H = 500;            // SVG viewport
  var ROOM_X = [0, 12], ROOM_Y = [0, 10]; // room bounds in metres
  var PAD = 40;                            // map padding in px
  var HFOV = 60;
  var HALF_FOV = (HFOV / 2) * Math.PI / 180;
  var CONE_R = 8;                          // camera effective range (m)

  // Person colours (consistent across views)
  var PERSON_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6"];
  var MOBILE_COLOR  = "#f472b6";  // pink for mobile camera

  // ────────────────────────────────────────────────
  //  State
  // ────────────────────────────────────────────────
  var _data = null;
  var _step = 0;
  var _camId = null;
  var _play = null;

  // ────────────────────────────────────────────────
  //  Map coordinate helpers
  // ────────────────────────────────────────────────
  var scaleX = (MAP_W - 2 * PAD) / (ROOM_X[1] - ROOM_X[0]);
  var scaleY = (MAP_H - 2 * PAD) / (ROOM_Y[1] - ROOM_Y[0]);
  var mapScale = Math.min(scaleX, scaleY);

  function m2px(wx, wy) {
    return {
      x: PAD + (wx - ROOM_X[0]) * mapScale,
      y: MAP_H - PAD - (wy - ROOM_Y[0]) * mapScale   // flip y for screen
    };
  }

  function ns(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }

  /**
   * Get camera state for the CURRENT timestep.
   * For mobile cameras, reads from camera_positions in the current frame.
   * For static cameras, returns the initial camera data.
   */
  function getCamAtStep(id, step) {
    if (!_data || !_data.cameras) return null;
    // Find base camera object
    var baseCam = null;
    for (var i = 0; i < _data.cameras.length; i++)
      if (_data.cameras[i].id === id) { baseCam = _data.cameras[i]; break; }
    if (!baseCam) return null;

    // If not mobile, return as-is
    if (!baseCam.mobile) return baseCam;

    // For mobile cameras, overlay per-timestep position/heading
    var ts = _data.timesteps || [];
    var frame = ts[step];
    if (!frame || !frame.camera_positions || !frame.camera_positions[id]) return baseCam;
    var cp = frame.camera_positions[id];
    return {
      id: baseCam.id,
      position: cp.position,
      heading: cp.heading,
      image_width: baseCam.image_width,
      image_height: baseCam.image_height,
      hfov_deg: baseCam.hfov_deg,
      mobile: true,
    };
  }

  function getCam(id) {
    return getCamAtStep(id, _step);
  }

  // ────────────────────────────────────────────────
  //  LOS / FOV helpers
  // ────────────────────────────────────────────────
  function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    function cross(ox, oy, px, py, qx, qy) {
      return (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
    }
    return (cross(ax, ay, bx, by, cx, cy) * cross(ax, ay, bx, by, dx, dy) < 0) &&
           (cross(cx, cy, dx, dy, ax, ay) * cross(cx, cy, dx, dy, bx, by) < 0);
  }

  function rayFirstWall(ox, oy, tx, ty, walls) {
    if (!walls || !walls.length) return null;
    var best = null, bestT = Infinity;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var cx = w[0][0], cy = w[0][1], dx = w[1][0], dy = w[1][1];
      var den = (tx - ox) * (dy - cy) - (ty - oy) * (dx - cx);
      if (Math.abs(den) < 1e-10) continue;
      var t = ((cx - ox) * (dy - cy) - (cy - oy) * (dx - cx)) / den;
      var s = ((cx - ox) * (ty - oy) - (cy - oy) * (tx - ox)) / den;
      if (t > 1e-5 && t <= 1 && s >= 0 && s <= 1) {
        if (t < bestT) {
          bestT = t;
          best = { x: ox + t * (tx - ox), y: oy + t * (ty - oy) };
        }
      }
    }
    return best;
  }

  // ────────────────────────────────────────────────
  //  Camera Feed drawing (Canvas)
  // ────────────────────────────────────────────────

  function drawFeed(cam, feed) {
    var canvas = document.getElementById("feed-canvas");
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;

    // Background gradient (simulates a dark room)
    var grad = ctx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, w * 0.7);
    grad.addColorStop(0, "#1a1a28");
    grad.addColorStop(1, "#08080d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Grid overlay (subtle scanlines)
    ctx.strokeStyle = "rgba(60,60,90,0.06)";
    ctx.lineWidth = 0.5;
    for (var gy = 0; gy < h; gy += 40) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
    }
    for (var gx = 0; gx < w; gx += 40) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
    }

    // Centre crosshair
    ctx.strokeStyle = "rgba(99,102,241,0.15)";
    ctx.lineWidth = 0.5;
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);

    // FOV edge markers
    ctx.strokeStyle = "rgba(99,102,241,0.25)";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(w, h); ctx.stroke();

    // Camera label
    var camColor = cam.mobile ? MOBILE_COLOR : "rgba(99,102,241,0.5)";
    ctx.fillStyle = camColor;
    ctx.font = "bold 13px 'DM Sans', system-ui, sans-serif";
    ctx.fillText(cam.id.toUpperCase(), 12, 22);

    // Mobile badge
    if (cam.mobile) {
      ctx.fillStyle = "rgba(244,114,182,0.2)";
      ctx.beginPath();
      roundRect(ctx, 12, 28, 60, 16, 3);
      ctx.fill();
      ctx.fillStyle = MOBILE_COLOR;
      ctx.font = "bold 9px 'DM Sans', system-ui, sans-serif";
      ctx.fillText("MOBILE", 18, 40);

      // Position readout
      ctx.fillStyle = "rgba(244,114,182,0.4)";
      ctx.font = "10px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(
        "pos (" + cam.position[0].toFixed(1) + ", " + cam.position[1].toFixed(1) + ")  hdg " + cam.heading.toFixed(0) + "\u00B0",
        12, 58
      );
    }

    // FOV label
    ctx.fillStyle = cam.mobile ? "rgba(244,114,182,0.3)" : "rgba(99,102,241,0.3)";
    ctx.font = "11px 'DM Sans', system-ui, sans-serif";
    ctx.fillText(HFOV + "\u00B0 FOV", cam.mobile ? 80 : 12, cam.mobile ? 40 : 38);

    if (!feed || !feed.detections || !feed.detections.length) {
      ctx.fillStyle = "rgba(100,100,130,0.3)";
      ctx.font = "14px 'DM Sans', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No detections", w / 2, h / 2);
      ctx.textAlign = "left";
      return;
    }

    // Draw bounding boxes
    var dets = feed.detections;
    for (var i = 0; i < dets.length; i++) {
      var d = dets[i];
      var bbox = d.bbox;
      var x1 = bbox[0], y1 = bbox[1], x2 = bbox[2], y2 = bbox[3];
      var bw = x2 - x1, bh = y2 - y1;
      var col = PERSON_COLORS[(d.person_id - 1) % PERSON_COLORS.length];

      // Bbox fill
      ctx.fillStyle = hexToRgba(col, 0.1);
      ctx.fillRect(x1, y1, bw, bh);

      // Bbox border
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, bw, bh);

      // Corner accents
      var cs = Math.min(12, bw * 0.3, bh * 0.3);
      ctx.lineWidth = 3;
      // Top-left
      ctx.beginPath(); ctx.moveTo(x1, y1 + cs); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cs, y1); ctx.stroke();
      // Top-right
      ctx.beginPath(); ctx.moveTo(x2 - cs, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cs); ctx.stroke();
      // Bottom-left
      ctx.beginPath(); ctx.moveTo(x1, y2 - cs); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cs, y2); ctx.stroke();
      // Bottom-right
      ctx.beginPath(); ctx.moveTo(x2 - cs, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cs); ctx.stroke();

      // Label background
      var label = "P" + d.person_id;
      var distLabel = d.estimated_distance.toFixed(1) + "m";
      var fullLabel = label + "  " + distLabel;
      ctx.font = "bold 11px 'DM Sans', system-ui, sans-serif";
      var tw = ctx.measureText(fullLabel).width + 10;
      var lh = 18;
      var lx = x1, ly = y1 - lh - 2;
      if (ly < 2) ly = y2 + 4;

      ctx.fillStyle = hexToRgba(col, 0.85);
      ctx.beginPath();
      roundRect(ctx, lx, ly, tw, lh, 3);
      ctx.fill();

      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(fullLabel, lx + 5, ly + 13);

      // Height indicator bar (right side of bbox)
      ctx.fillStyle = hexToRgba(col, 0.4);
      ctx.fillRect(x2 + 4, y1, 3, bh);

      // Height label
      ctx.fillStyle = hexToRgba(col, 0.6);
      ctx.font = "9px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(Math.round(bh) + "px", x2 + 10, y1 + bh / 2 + 3);

      // Error label at bottom of bbox
      if (d.error_m !== undefined) {
        var errTxt = "err: " + d.error_m.toFixed(2) + "m";
        var errCol = d.error_m < 0.5 ? "#22c55e" : d.error_m < 1.5 ? "#eab308" : "#ef4444";
        ctx.fillStyle = errCol;
        ctx.font = "9px 'DM Sans', system-ui, sans-serif";
        ctx.fillText(errTxt, x1, y2 + 14);
      }
    }

    // HUD: detection count
    ctx.fillStyle = "rgba(200,200,220,0.4)";
    ctx.font = "11px 'DM Sans', system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(dets.length + " detection" + (dets.length !== 1 ? "s" : ""), w - 12, 22);
    ctx.textAlign = "left";
  }

  function hexToRgba(hex, alpha) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + alpha + ")";
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ────────────────────────────────────────────────
  //  Feed info & detection list
  // ────────────────────────────────────────────────

  function updateFeedInfo(cam, feed) {
    var el = document.getElementById("feed-info");
    var nd = feed && feed.detections ? feed.detections.length : 0;
    el.innerHTML = "<strong>" + cam.id + "</strong> &nbsp;&middot;&nbsp; " +
      "pos (" + cam.position[0].toFixed(1) + ", " + cam.position[1].toFixed(1) + ") &nbsp;&middot;&nbsp; " +
      "heading " + cam.heading + "&deg; &nbsp;&middot;&nbsp; " +
      nd + " detection" + (nd !== 1 ? "s" : "");
    document.getElementById("feed-title").textContent = cam.id + " Feed";
  }

  function updateDetectionList(feed) {
    var el = document.getElementById("detection-list");
    if (!feed || !feed.detections || !feed.detections.length) {
      el.innerHTML = '<div style="padding:0.5rem;color:#555">No detections this frame</div>';
      return;
    }
    var html = "";
    for (var i = 0; i < feed.detections.length; i++) {
      var d = feed.detections[i];
      var col = PERSON_COLORS[(d.person_id - 1) % PERSON_COLORS.length];
      var errClass = d.error_m < 0.5 ? "good" : d.error_m < 1.5 ? "ok" : "bad";
      html +=
        '<div class="det-row">' +
          '<span class="det-id" style="color:' + col + '">P' + d.person_id + '</span>' +
          '<span class="det-metric">dist <span>' + d.estimated_distance.toFixed(1) + 'm</span></span>' +
          '<span class="det-metric">bearing <span>' + d.bearing_deg.toFixed(0) + '&deg;</span></span>' +
          '<span class="det-metric">est <span>(' + d.estimated_position[0].toFixed(1) + ', ' + d.estimated_position[1].toFixed(1) + ')</span></span>' +
          '<span class="det-error ' + errClass + '">&Delta; ' + d.error_m.toFixed(2) + 'm</span>' +
        '</div>';
    }
    el.innerHTML = html;
  }

  // ────────────────────────────────────────────────
  //  Overhead Map drawing (SVG)
  // ────────────────────────────────────────────────

  function drawMapGrid() {
    var g = document.getElementById("grid-layer");
    g.innerHTML = "";
    // Room outline
    var corners = [[ROOM_X[0], ROOM_Y[0]], [ROOM_X[1], ROOM_Y[0]],
                   [ROOM_X[1], ROOM_Y[1]], [ROOM_X[0], ROOM_Y[1]]];
    var pts = corners.map(function (c) { return m2px(c[0], c[1]); });
    var d = "M " + pts[0].x + " " + pts[0].y;
    for (var i = 1; i < pts.length; i++) d += " L " + pts[i].x + " " + pts[i].y;
    d += " Z";
    var p = ns("path"); p.setAttribute("d", d); p.setAttribute("class", "room-bounds");
    g.appendChild(p);

    // Grid lines every 2m
    for (var gx = ROOM_X[0]; gx <= ROOM_X[1]; gx += 2) {
      var a = m2px(gx, ROOM_Y[0]), b = m2px(gx, ROOM_Y[1]);
      var ln = ns("line");
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
      ln.setAttribute("class", "grid-line");
      g.appendChild(ln);
    }
    for (var gy = ROOM_Y[0]; gy <= ROOM_Y[1]; gy += 2) {
      var a2 = m2px(ROOM_X[0], gy), b2 = m2px(ROOM_X[1], gy);
      var ln2 = ns("line");
      ln2.setAttribute("x1", a2.x); ln2.setAttribute("y1", a2.y);
      ln2.setAttribute("x2", b2.x); ln2.setAttribute("y2", b2.y);
      ln2.setAttribute("class", "grid-line");
      g.appendChild(ln2);
    }
  }

  function drawMapWalls(walls) {
    var g = document.getElementById("walls-layer");
    g.innerHTML = "";
    (walls || []).forEach(function (w) {
      var a = m2px(w[0][0], w[0][1]), b = m2px(w[1][0], w[1][1]);
      var ln = ns("line");
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
      ln.setAttribute("class", "wall-line");
      g.appendChild(ln);
    });
  }

  function drawMapFov(cam, walls) {
    var g = document.getElementById("fov-layer");
    g.innerHTML = "";
    var cx = cam.position[0], cy = cam.position[1];
    var h = cam.heading * Math.PI / 180;
    var a1 = h - HALF_FOV, a2 = h + HALF_FOV;
    var steps = 40;
    var pts = [];
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var a = a1 + t * (a2 - a1);
      var fx = cx + 50 * Math.cos(a), fy = cy + 50 * Math.sin(a);
      var hit = rayFirstWall(cx, cy, fx, fy, walls);
      var ex, ey;
      if (hit) {
        var ddx = hit.x - cx, ddy = hit.y - cy;
        var dist = Math.sqrt(ddx * ddx + ddy * ddy);
        if (dist < CONE_R) { ex = cx + ddx * 0.999; ey = cy + ddy * 0.999; }
        else { ex = cx + CONE_R * Math.cos(a); ey = cy + CONE_R * Math.sin(a); }
      } else {
        ex = cx + CONE_R * Math.cos(a); ey = cy + CONE_R * Math.sin(a);
      }
      pts.push(m2px(ex, ey));
    }
    var cPx = m2px(cx, cy);
    var dd = "M " + cPx.x + " " + cPx.y;
    for (var j = 0; j < pts.length; j++) dd += " L " + pts[j].x + " " + pts[j].y;
    dd += " Z";
    var path = ns("path"); path.setAttribute("d", dd); path.setAttribute("class", "fov-cone");
    g.appendChild(path);
  }

  /** Draw the mobile camera's recent trail (last ~2 seconds). */
  function drawMobileTrail(camId) {
    var g = document.getElementById("cameras-layer");
    if (!_data || !_data.timesteps) return;
    var trailSteps = Math.min(60, _step);  // ~2 seconds at 30 fps
    if (trailSteps < 2) return;

    for (var i = 0; i < trailSteps; i++) {
      var si = _step - trailSteps + i;
      if (si < 0) continue;
      var frame = _data.timesteps[si];
      if (!frame || !frame.camera_positions || !frame.camera_positions[camId]) continue;
      var cp = frame.camera_positions[camId];
      var s = m2px(cp.position[0], cp.position[1]);
      var opacity = 0.05 + 0.25 * (i / trailSteps);
      var dot = ns("circle");
      dot.setAttribute("cx", s.x); dot.setAttribute("cy", s.y);
      dot.setAttribute("r", 1.5);
      dot.setAttribute("fill", "rgba(244,114,182," + opacity + ")");
      dot.setAttribute("class", "mobile-trail");
      g.appendChild(dot);
    }
  }

  function drawMapCameras(cameras, activeCamId) {
    var g = document.getElementById("cameras-layer");
    g.innerHTML = "";

    // Draw mobile trails first (behind markers)
    cameras.forEach(function (baseCam) {
      if (baseCam.mobile) drawMobileTrail(baseCam.id);
    });

    cameras.forEach(function (baseCam) {
      // Get current-timestep state for this camera
      var cam = getCamAtStep(baseCam.id, _step);
      if (!cam) return;
      var s = m2px(cam.position[0], cam.position[1]);
      var isActive = cam.id === activeCamId;
      var isMobile = !!cam.mobile;

      // Triangle pointing in heading direction
      var h = cam.heading * Math.PI / 180;
      var sz = isActive ? 10 : 7;
      var hdx = Math.cos(h) * mapScale;
      var hdy = -Math.sin(h) * mapScale;  // flip y for screen
      var len = Math.sqrt(hdx * hdx + hdy * hdy) || 1;
      hdx /= len; hdy /= len;
      var perpX = -hdy, perpY = hdx;

      var tipPt = { x: s.x + hdx * sz * 1.5, y: s.y + hdy * sz * 1.5 };
      var left  = { x: s.x - hdx * sz * 0.5 + perpX * sz * 0.5, y: s.y - hdy * sz * 0.5 + perpY * sz * 0.5 };
      var right = { x: s.x - hdx * sz * 0.5 - perpX * sz * 0.5, y: s.y - hdy * sz * 0.5 - perpY * sz * 0.5 };

      // Choose colour: pink for mobile, indigo for static
      var fillCol, strokeCol, glowCol;
      if (isMobile) {
        fillCol = isActive ? MOBILE_COLOR : "rgba(244,114,182,0.5)";
        strokeCol = isActive ? "#f9a8d4" : "rgba(244,114,182,0.3)";
        glowCol = "drop-shadow(0 0 6px rgba(244,114,182,0.5))";
      } else {
        fillCol = isActive ? "#6366f1" : "#4b4b6b";
        strokeCol = isActive ? "#818cf8" : "rgba(99,102,241,0.3)";
        glowCol = "drop-shadow(0 0 6px rgba(99,102,241,0.5))";
      }

      var path = ns("path");
      path.setAttribute("d",
        "M " + tipPt.x + " " + tipPt.y +
        " L " + left.x + " " + left.y +
        " L " + right.x + " " + right.y + " Z"
      );
      path.setAttribute("fill", fillCol);
      path.setAttribute("stroke", strokeCol);
      path.setAttribute("stroke-width", isActive ? 2 : 1);
      if (isActive) path.setAttribute("filter", glowCol);
      path.setAttribute("class", "cam-marker");
      (function (cid) {
        path.addEventListener("click", function () { setCam(cid); });
      })(cam.id);
      g.appendChild(path);

      // Label
      var lbl = ns("text");
      lbl.setAttribute("x", s.x); lbl.setAttribute("y", s.y + (isActive ? 20 : 16));
      lbl.setAttribute("text-anchor", "middle");
      var lblFill = isMobile
        ? (isActive ? "rgba(244,114,182,0.9)" : "rgba(244,114,182,0.5)")
        : (isActive ? "rgba(130,130,220,0.9)" : "rgba(120,120,180,0.5)");
      lbl.setAttribute("fill", lblFill);
      lbl.setAttribute("font-size", isActive ? "10" : "9");
      lbl.setAttribute("font-weight", isActive ? "600" : "400");
      lbl.setAttribute("class", "label");
      lbl.textContent = cam.id;
      g.appendChild(lbl);
    });
  }

  function drawMapTracks(feed, persons) {
    var gTracks = document.getElementById("tracks-layer");
    var gLines = document.getElementById("estimation-lines-layer");
    var gLabels = document.getElementById("labels-layer");
    gTracks.innerHTML = "";
    gLines.innerHTML = "";
    gLabels.innerHTML = "";

    // Draw all persons as actual positions
    (persons || []).forEach(function (p) {
      var col = PERSON_COLORS[(p.id - 1) % PERSON_COLORS.length];
      var s = m2px(p.position[0], p.position[1]);
      var dot = ns("circle");
      dot.setAttribute("cx", s.x); dot.setAttribute("cy", s.y);
      dot.setAttribute("r", 6);
      dot.setAttribute("fill", col);
      dot.setAttribute("stroke", "rgba(255,255,255,0.3)");
      dot.setAttribute("stroke-width", 1.5);
      dot.setAttribute("class", "actual-dot");
      gTracks.appendChild(dot);

      // Label
      var lbl = ns("text");
      lbl.setAttribute("x", s.x); lbl.setAttribute("y", s.y - 10);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("fill", "rgba(255,255,255,0.7)");
      lbl.setAttribute("font-size", "9");
      lbl.setAttribute("font-weight", "600");
      lbl.setAttribute("class", "label");
      lbl.textContent = "P" + p.id;
      gLabels.appendChild(lbl);
    });

    // Draw estimated positions from current camera's feed
    if (!feed || !feed.detections) return;
    feed.detections.forEach(function (d) {
      var col = PERSON_COLORS[(d.person_id - 1) % PERSON_COLORS.length];

      // Estimated position dot (dashed outline)
      var es = m2px(d.estimated_position[0], d.estimated_position[1]);
      var eDot = ns("circle");
      eDot.setAttribute("cx", es.x); eDot.setAttribute("cy", es.y);
      eDot.setAttribute("r", 5);
      eDot.setAttribute("fill", "rgba(245,158,11,0.5)");
      eDot.setAttribute("stroke", col);
      eDot.setAttribute("stroke-width", 1.5);
      eDot.setAttribute("stroke-dasharray", "3,2");
      eDot.setAttribute("class", "estimated-dot");
      gTracks.appendChild(eDot);

      // Error line (actual → estimated)
      var as = m2px(d.actual_position[0], d.actual_position[1]);
      if (d.error_m > 0.05) {
        var errCol = d.error_m < 0.5 ? "#22c55e" : d.error_m < 1.5 ? "#eab308" : "#ef4444";
        var errLine = ns("line");
        errLine.setAttribute("x1", as.x); errLine.setAttribute("y1", as.y);
        errLine.setAttribute("x2", es.x); errLine.setAttribute("y2", es.y);
        errLine.setAttribute("stroke", errCol);
        errLine.setAttribute("stroke-width", 1.5);
        errLine.setAttribute("class", "error-line");
        gLines.appendChild(errLine);
      }

      // Uncertainty circle
      var uncR = d.uncertainty_m * mapScale;
      if (uncR > 3) {
        var uncCircle = ns("circle");
        uncCircle.setAttribute("cx", es.x); uncCircle.setAttribute("cy", es.y);
        uncCircle.setAttribute("r", uncR);
        uncCircle.setAttribute("fill", "none");
        uncCircle.setAttribute("stroke", "rgba(245,158,11,0.15)");
        uncCircle.setAttribute("stroke-width", 1);
        uncCircle.setAttribute("stroke-dasharray", "4,3");
        gTracks.appendChild(uncCircle);
      }
    });
  }

  // ────────────────────────────────────────────────
  //  Main render
  // ────────────────────────────────────────────────

  function render() {
    if (!_data || !_camId) return;
    var cam = getCam(_camId);  // gets per-timestep position for mobile
    if (!cam) return;
    var walls = _data.walls || [];
    var ts = _data.timesteps || [];
    var frame = ts[_step] || { persons: [], camera_feeds: {} };
    var persons = frame.persons || [];
    var feed = (frame.camera_feeds || {})[_camId] || null;

    // Camera feed (canvas)
    drawFeed(cam, feed);
    updateFeedInfo(cam, feed);
    updateDetectionList(feed);

    // Overhead map (SVG)
    drawMapGrid();
    drawMapWalls(walls);
    drawMapFov(cam, walls);
    drawMapCameras(_data.cameras || [], _camId);
    drawMapTracks(feed, persons);
  }

  // ────────────────────────────────────────────────
  //  Controls
  // ────────────────────────────────────────────────

  function setStep(i) {
    if (!_data || !_data.timesteps) return;
    var n = _data.timesteps.length;
    if (n === 0) return;
    _step = Math.max(0, Math.min(i, n - 1));
    render();
    document.getElementById("time-slider").value = _step;
    document.getElementById("time-label").textContent =
      "t = " + _data.timesteps[_step].t.toFixed(1) + " s";
    document.getElementById("frame-label").textContent =
      (_step + 1) + " / " + n;
  }

  function setCam(id) {
    _camId = id;
    var tabs = document.querySelectorAll(".cam-tab");
    for (var i = 0; i < tabs.length; i++)
      tabs[i].classList.toggle("active", tabs[i].getAttribute("data-cam-id") === id);
    render();
  }

  function buildTabs(cameras) {
    var el = document.getElementById("cam-tabs");
    el.innerHTML = "";
    cameras.forEach(function (c, i) {
      var btn = document.createElement("button");
      btn.className = "cam-tab" + (i === 0 ? " active" : "") + (c.mobile ? " mobile" : "");
      btn.textContent = c.mobile ? "\u{1F6B6} " + c.id : c.id;
      btn.setAttribute("data-cam-id", c.id);
      btn.title = c.id + (c.mobile ? " (mobile)" : "") + "  (press " + (i + 1) + ")";
      btn.addEventListener("click", function () { setCam(c.id); });
      el.appendChild(btn);
    });
  }

  // ────────────────────────────────────────────────
  //  Data fetch
  // ────────────────────────────────────────────────

  function fetchData() {
    var status = document.getElementById("status");
    status.textContent = "Loading\u2026";
    fetch("/api/map")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        _data = d;
        _step = 0;
        var cams = d.cameras || [];
        if (cams.length > 0) {
          _camId = _camId || cams[0].id;
          buildTabs(cams);
        }
        var n = d.timesteps ? d.timesteps.length : 0;
        var np = (d.timesteps && d.timesteps[0]) ? d.timesteps[0].persons.length : 0;
        status.textContent = n + " steps \u00B7 " + np + " persons \u00B7 " + cams.length + " cameras";
        var slider = document.getElementById("time-slider");
        slider.min = 0;
        slider.max = Math.max(0, n - 1);
        slider.value = 0;
        document.getElementById("time-label").textContent = "t = 0.0 s";
        document.getElementById("frame-label").textContent = "1 / " + n;
        render();
      })
      .catch(function (err) {
        status.textContent = "Error: " + err.message;
      });
  }

  // ────────────────────────────────────────────────
  //  Event listeners
  // ────────────────────────────────────────────────

  document.getElementById("step-prev").addEventListener("click", function () { setStep(_step - 1); });
  document.getElementById("step-next").addEventListener("click", function () { setStep(_step + 1); });
  document.getElementById("time-slider").addEventListener("input", function () {
    setStep(parseInt(this.value, 10));
  });

  document.getElementById("play-pause").addEventListener("click", function () {
    if (_play) {
      clearInterval(_play); _play = null;
      this.textContent = "Play";
      return;
    }
    var btn = this;
    btn.textContent = "Pause";
    _play = setInterval(function () {
      if (!_data || !_data.timesteps || _data.timesteps.length === 0) return;
      var next = _step + 1;
      if (next >= _data.timesteps.length) next = 0;
      setStep(next);
    }, 33);
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      document.getElementById("play-pause").click();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setStep(_step - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      setStep(_step + 1);
    } else if (e.key >= "1" && e.key <= "9") {
      var idx = parseInt(e.key, 10) - 1;
      if (_data && _data.cameras && idx < _data.cameras.length)
        setCam(_data.cameras[idx].id);
    }
  });

  // ────────────────────────────────────────────────
  //  Boot
  // ────────────────────────────────────────────────
  fetchData();
})();
