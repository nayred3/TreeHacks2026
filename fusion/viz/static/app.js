(function () {
  "use strict";

  // ────────────────────────────────────────────────
  //  Constants
  // ────────────────────────────────────────────────
  var FEED_W = 640, FEED_H = 480;
  var VIEW_W = 800, VIEW_H = 600;
  var PAD = 40;
  var WORLD_X = [0, 12], WORLD_Y = [0, 10];
  var HFOV = 60;
  var HALF_FOV = (HFOV / 2) * Math.PI / 180;
  var CONE_R = 8;
  var VIEW_RADIUS = 10;   // metres visible from camera centre in each direction

  var PERSON_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6"];
  var MOBILE_COLOR  = "#f472b6";

  // ────────────────────────────────────────────────
  //  State
  // ────────────────────────────────────────────────
  var _data  = null;
  var _step  = 0;
  var _camId = null;
  var _play  = null;
  var _viewCx = 6;        // current view centre (world metres)
  var _viewCy = 5;
  var _viewHeading = 0;   // camera heading in degrees (used when heading-up)
  var _headingUp = true;  // true = heading points up; false = north up
  var _liveMode = false;  // true when connected to live_fusion.py
  var _liveTimer = null;

  // ────────────────────────────────────────────────
  //  Coordinate helpers — camera-centred view
  // ────────────────────────────────────────────────

  /** Pixels per metre for the current view */
  function pxPerM() {
    return (Math.min(VIEW_W, VIEW_H) - 2 * PAD) / (2 * VIEW_RADIUS);
  }

  /**
   * World (x, y) → SVG pixel.  View is centred on (_viewCx, _viewCy).
   *
   * When _headingUp is true the map is rotated so the camera's heading
   * direction always points up on screen.  When false, north (+y) is up.
   */
  function w2s(x, y) {
    var scale = pxPerM();
    var dx = x - _viewCx;
    var dy = y - _viewCy;

    if (_headingUp) {
      // Rotate so camera heading → screen up
      var h = _viewHeading * Math.PI / 180;
      var a = Math.PI / 2 - h;            // rotation angle
      var rx =  dx * Math.cos(a) - dy * Math.sin(a);
      var ry =  dx * Math.sin(a) + dy * Math.cos(a);
      return {
        x: VIEW_W / 2 + rx * scale,
        y: VIEW_H / 2 - ry * scale,
      };
    }

    // North-up (no rotation)
    return {
      x: VIEW_W / 2 + dx * scale,
      y: VIEW_H / 2 - dy * scale,
    };
  }

  function ns(tag) { return document.createElementNS("http://www.w3.org/2000/svg", tag); }

  // ────────────────────────────────────────────────
  //  Camera state (per-timestep for mobile)
  // ────────────────────────────────────────────────
  function getCamAtStep(id, step) {
    if (!_data || !_data.cameras) return null;
    var baseCam = null;
    for (var i = 0; i < _data.cameras.length; i++)
      if (_data.cameras[i].id === id) { baseCam = _data.cameras[i]; break; }
    if (!baseCam) return null;
    if (!baseCam.mobile) return baseCam;
    var ts = _data.timesteps || [];
    var frame = ts[step];
    if (!frame || !frame.camera_positions || !frame.camera_positions[id]) return baseCam;
    var cp = frame.camera_positions[id];
    return {
      id: baseCam.id, position: cp.position, heading: cp.heading,
      image_width: baseCam.image_width, image_height: baseCam.image_height,
      hfov_deg: baseCam.hfov_deg, mobile: true,
    };
  }

  function getCam(id) { return getCamAtStep(id, _step); }

  // ────────────────────────────────────────────────
  //  Staleness color
  // ────────────────────────────────────────────────
  function staleColor(lastT, now) {
    if (now == null) now = lastT;
    var age = now - lastT;
    if (age <= 0.5) return "#22c55e";
    if (age <= 1.5) return "#eab308";
    return "#ef4444";
  }

  // ────────────────────────────────────────────────
  //  Geometry helpers
  // ────────────────────────────────────────────────
  function segIntPt(ax, ay, bx, by, cx, cy, dx, dy) {
    var den = (bx - ax) * (dy - cy) - (by - ay) * (dx - cx);
    if (Math.abs(den) < 1e-10) return null;
    var t = ((cx - ax) * (dy - cy) - (cy - ay) * (dx - cx)) / den;
    var s = ((cx - ax) * (by - ay) - (cy - ay) * (bx - ax)) / den;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1)
      return { x: ax + t * (bx - ax), y: ay + t * (by - ay), t: t };
    return null;
  }

  function rayFirstWall(ox, oy, tx, ty, walls) {
    if (!walls || !walls.length) return null;
    var best = null, bestT = Infinity;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      var pt = segIntPt(ox, oy, tx, ty, w[0][0], w[0][1], w[1][0], w[1][1]);
      if (pt && pt.t > 1e-5 && pt.t < bestT) { bestT = pt.t; best = pt; }
    }
    return best;
  }

  function _cross(ox, oy, ax, ay, bx, by) {
    return (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);
  }

  function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
    return (_cross(ax, ay, bx, by, cx, cy) * _cross(ax, ay, bx, by, dx, dy) < 0) &&
           (_cross(cx, cy, dx, dy, ax, ay) * _cross(cx, cy, dx, dy, bx, by) < 0);
  }

  function hasLos(o, t, walls) {
    if (!walls || !walls.length) return true;
    for (var i = 0; i < walls.length; i++) {
      var w = walls[i];
      if (segCross(o[0], o[1], t[0], t[1], w[0][0], w[0][1], w[1][0], w[1][1]))
        return false;
    }
    return true;
  }

  function canSee(cam, pos, walls) {
    var dx = pos[0] - cam.position[0], dy = pos[1] - cam.position[1];
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > CONE_R) return false;
    if (dist < 1e-6) return true;
    var a = Math.atan2(dy, dx);
    var h = (cam.heading || 0) * Math.PI / 180;
    var diff = a - h;
    diff = ((diff + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    if (Math.abs(diff) > HALF_FOV) return false;
    return hasLos([cam.position[0], cam.position[1]], pos, walls);
  }

  // ────────────────────────────────────────────────
  //  Tooltip
  // ────────────────────────────────────────────────
  function posTip(el, e) {
    var box = document.getElementById("map-container");
    if (!box) return;
    var r = box.getBoundingClientRect();
    var x = e.clientX - r.left + 14;
    var y = e.clientY - r.top  + 14;
    el.style.left = Math.min(Math.max(x, 8), r.width  - 220) + "px";
    el.style.top  = Math.min(Math.max(y, 8), r.height - 100) + "px";
  }

  // ════════════════════════════════════════════════
  //  CAMERA FEED (Canvas)
  // ════════════════════════════════════════════════

  function drawFeed(cam, feed) {
    var canvas = document.getElementById("feed-canvas");
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;

    var grad = ctx.createRadialGradient(w / 2, h / 2, 50, w / 2, h / 2, w * 0.7);
    grad.addColorStop(0, "#1a1a28");
    grad.addColorStop(1, "#08080d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Scanlines
    ctx.strokeStyle = "rgba(60,60,90,0.06)";
    ctx.lineWidth = 0.5;
    for (var gy = 0; gy < h; gy += 40) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }
    for (var gx = 0; gx < w; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }

    // Crosshair
    ctx.strokeStyle = "rgba(99,102,241,0.15)";
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    ctx.setLineDash([]);

    // FOV edges
    ctx.strokeStyle = "rgba(99,102,241,0.25)"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w, 0); ctx.lineTo(w, h); ctx.stroke();

    // Camera label
    var camColor = cam.mobile ? MOBILE_COLOR : "rgba(99,102,241,0.5)";
    ctx.fillStyle = camColor;
    ctx.font = "bold 13px 'DM Sans', system-ui, sans-serif";
    ctx.fillText(cam.id.toUpperCase(), 12, 22);

    if (cam.mobile) {
      ctx.fillStyle = "rgba(244,114,182,0.2)";
      ctx.beginPath(); roundRect(ctx, 12, 28, 60, 16, 3); ctx.fill();
      ctx.fillStyle = MOBILE_COLOR;
      ctx.font = "bold 9px 'DM Sans', system-ui, sans-serif";
      ctx.fillText("MOBILE", 18, 40);
      ctx.fillStyle = "rgba(244,114,182,0.4)";
      ctx.font = "10px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(
        "pos (" + cam.position[0].toFixed(1) + ", " + cam.position[1].toFixed(1) + ")  hdg " + cam.heading.toFixed(0) + "\u00B0",
        12, 58
      );
    }

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

    var dets = feed.detections;
    for (var i = 0; i < dets.length; i++) {
      var d = dets[i];
      var bbox = d.bbox;
      var x1 = bbox[0], y1 = bbox[1], x2 = bbox[2], y2 = bbox[3];
      var bw = x2 - x1, bh = y2 - y1;
      var col = PERSON_COLORS[(d.person_id - 1) % PERSON_COLORS.length];

      ctx.fillStyle = hexToRgba(col, 0.1);
      ctx.fillRect(x1, y1, bw, bh);
      ctx.strokeStyle = col; ctx.lineWidth = 2;
      ctx.strokeRect(x1, y1, bw, bh);

      var cs = Math.min(12, bw * 0.3, bh * 0.3);
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(x1, y1 + cs); ctx.lineTo(x1, y1); ctx.lineTo(x1 + cs, y1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2 - cs, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + cs); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y2 - cs); ctx.lineTo(x1, y2); ctx.lineTo(x1 + cs, y2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x2 - cs, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - cs); ctx.stroke();

      var label = "P" + d.person_id;
      var distLabel = d.estimated_distance.toFixed(1) + "m";
      var fullLabel = label + "  " + distLabel;
      ctx.font = "bold 11px 'DM Sans', system-ui, sans-serif";
      var tw = ctx.measureText(fullLabel).width + 10;
      var lh = 18, lx = x1, ly = y1 - lh - 2;
      if (ly < 2) ly = y2 + 4;
      ctx.fillStyle = hexToRgba(col, 0.85);
      ctx.beginPath(); roundRect(ctx, lx, ly, tw, lh, 3); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "bold 11px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(fullLabel, lx + 5, ly + 13);

      ctx.fillStyle = hexToRgba(col, 0.4);
      ctx.fillRect(x2 + 4, y1, 3, bh);
      ctx.fillStyle = hexToRgba(col, 0.6);
      ctx.font = "9px 'DM Sans', system-ui, sans-serif";
      ctx.fillText(Math.round(bh) + "px", x2 + 10, y1 + bh / 2 + 3);

      if (d.error_m !== undefined) {
        var errTxt = "err: " + d.error_m.toFixed(2) + "m";
        var errCol = d.error_m < 0.5 ? "#22c55e" : d.error_m < 1.5 ? "#eab308" : "#ef4444";
        ctx.fillStyle = errCol;
        ctx.font = "9px 'DM Sans', system-ui, sans-serif";
        ctx.fillText(errTxt, x1, y2 + 14);
      }
    }

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
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
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
  //  Feed info + detection list
  // ────────────────────────────────────────────────
  function updateFeedInfo(cam, feed) {
    var el = document.getElementById("feed-info");
    var nd = feed && feed.detections ? feed.detections.length : 0;
    el.innerHTML = "<strong>" + cam.id + "</strong> &nbsp;&middot;&nbsp; " +
      "pos (" + cam.position[0].toFixed(1) + ", " + cam.position[1].toFixed(1) + ") &nbsp;&middot;&nbsp; " +
      "heading " + (typeof cam.heading === "number" ? cam.heading.toFixed(0) : cam.heading) + "&deg; &nbsp;&middot;&nbsp; " +
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

  // ════════════════════════════════════════════════
  //  OVERHEAD MAP (SVG)
  // ════════════════════════════════════════════════

  function drawGrid() {
    var g = document.getElementById("grid-layer");
    g.innerHTML = "";
    var cx = VIEW_W / 2, cy = VIEW_H / 2;
    var scale = pxPerM();

    // Range rings every 2 m
    var rings = [2, 4, 6, 8, 10];
    for (var ri = 0; ri < rings.length; ri++) {
      var r = rings[ri] * scale;
      var c = ns("circle");
      c.setAttribute("cx", cx); c.setAttribute("cy", cy); c.setAttribute("r", r);
      c.setAttribute("class", rings[ri] === CONE_R ? "range-ring cone-ring" : "range-ring");
      g.appendChild(c);
      // Label
      var t = ns("text");
      t.setAttribute("x", cx + r + 4); t.setAttribute("y", cy - 3);
      t.setAttribute("class", "range-label");
      t.textContent = rings[ri] + "m";
      g.appendChild(t);
    }

    // Crosshair through centre
    var h = ns("line"); h.setAttribute("x1", PAD); h.setAttribute("y1", cy);
    h.setAttribute("x2", VIEW_W - PAD); h.setAttribute("y2", cy);
    h.setAttribute("class", "crosshair"); g.appendChild(h);
    var v = ns("line"); v.setAttribute("x1", cx); v.setAttribute("y1", PAD);
    v.setAttribute("x2", cx); v.setAttribute("y2", VIEW_H - PAD);
    v.setAttribute("class", "crosshair"); g.appendChild(v);

    // Room outline (simulation mode only — live mode has no fixed room)
    if (!_liveMode) {
      var corners = [
        [WORLD_X[0], WORLD_Y[0]], [WORLD_X[1], WORLD_Y[0]],
        [WORLD_X[1], WORLD_Y[1]], [WORLD_X[0], WORLD_Y[1]]
      ];
      var pts = corners.map(function (cc) { return w2s(cc[0], cc[1]); });
      var dd = "M " + pts[0].x + " " + pts[0].y;
      for (var i = 1; i < pts.length; i++) dd += " L " + pts[i].x + " " + pts[i].y;
      dd += " Z";
      var room = ns("path"); room.setAttribute("d", dd); room.setAttribute("class", "room-bounds");
      g.appendChild(room);
    }

    // ── Compass (shows where north is) ──
    var ccx = VIEW_W - 50, ccy = 50, cr = 24;
    var bgC = ns("circle");
    bgC.setAttribute("cx", ccx); bgC.setAttribute("cy", ccy); bgC.setAttribute("r", cr);
    bgC.setAttribute("class", "compass-bg"); g.appendChild(bgC);

    // North direction on screen
    var northAngle;
    if (_headingUp) {
      // When heading-up, north (+y in world) is rotated by the camera heading
      var hRad = _viewHeading * Math.PI / 180;
      var rotA = Math.PI / 2 - hRad;
      // World north = (0, 1). Rotated: rx = -sin(a), ry = cos(a). Screen: flip ry.
      var snx = -Math.sin(rotA);
      var sny = -Math.cos(rotA);   // flip for SVG y
      northAngle = Math.atan2(sny, snx);
    } else {
      northAngle = -Math.PI / 2;  // straight up
    }

    var al = cr * 0.7;
    var nLn = ns("line");
    nLn.setAttribute("x1", ccx); nLn.setAttribute("y1", ccy);
    nLn.setAttribute("x2", ccx + Math.cos(northAngle) * al);
    nLn.setAttribute("y2", ccy + Math.sin(northAngle) * al);
    nLn.setAttribute("class", "compass-needle"); g.appendChild(nLn);

    // Arrowhead
    var ahSz = 5;
    var ax = ccx + Math.cos(northAngle) * al;
    var ay = ccy + Math.sin(northAngle) * al;
    var perpNx = -Math.sin(northAngle), perpNy = Math.cos(northAngle);
    var arr = ns("polygon");
    arr.setAttribute("points",
      (ax + Math.cos(northAngle) * ahSz) + "," + (ay + Math.sin(northAngle) * ahSz) + " " +
      (ax + perpNx * ahSz * 0.6) + "," + (ay + perpNy * ahSz * 0.6) + " " +
      (ax - perpNx * ahSz * 0.6) + "," + (ay - perpNy * ahSz * 0.6)
    );
    arr.setAttribute("fill", "rgba(255,80,80,0.7)"); g.appendChild(arr);

    // N label
    var nLbl = ns("text");
    nLbl.setAttribute("x", ccx + Math.cos(northAngle) * (al + 11));
    nLbl.setAttribute("y", ccy + Math.sin(northAngle) * (al + 11) + 4);
    nLbl.setAttribute("text-anchor", "middle");
    nLbl.setAttribute("class", "compass-label");
    nLbl.textContent = "N"; g.appendChild(nLbl);

    // Heading label below compass
    var hLbl = ns("text");
    hLbl.setAttribute("x", ccx); hLbl.setAttribute("y", ccy + cr + 14);
    hLbl.setAttribute("text-anchor", "middle");
    hLbl.setAttribute("class", "compass-heading-label");
    hLbl.textContent = Math.round(_viewHeading) + "\u00B0"; g.appendChild(hLbl);

    // "▲ Heading" label at top-centre when heading-up mode
    if (_headingUp) {
      var hul = ns("text");
      hul.setAttribute("x", VIEW_W / 2); hul.setAttribute("y", 18);
      hul.setAttribute("text-anchor", "middle");
      hul.setAttribute("class", "heading-up-label");
      hul.textContent = "\u25B2 Heading"; g.appendChild(hul);
    }
  }

  function drawWalls(walls) {
    var g = document.getElementById("walls-layer");
    g.innerHTML = "";
    (walls || []).forEach(function (w) {
      var a = w2s(w[0][0], w[0][1]), b = w2s(w[1][0], w[1][1]);
      var ln = ns("line");
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
      ln.setAttribute("class", "wall-line"); g.appendChild(ln);
    });
  }

  // Draw vision cones for ALL cameras, highlighting the selected one
  function drawVisionCones(cameras, activeCamId, walls) {
    var g = document.getElementById("vision-cones-layer");
    g.innerHTML = "";
    cameras.forEach(function (baseCam) {
      var cam = getCamAtStep(baseCam.id, _step);
      if (!cam) return;
      var cx = cam.position[0], cy = cam.position[1];
      var h = (cam.heading || 0) * Math.PI / 180;
      var camHalfFov = cam.hfov_deg ? (cam.hfov_deg / 2) * Math.PI / 180 : HALF_FOV;
      var a1 = h - camHalfFov, a2 = h + camHalfFov;
      var steps = 60;
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
        pts.push(w2s(ex, ey));
      }
      var cPx = w2s(cx, cy);
      var dd = "M " + cPx.x + " " + cPx.y;
      for (var j = 0; j < pts.length; j++) dd += " L " + pts[j].x + " " + pts[j].y;
      dd += " Z";
      var path = ns("path");
      path.setAttribute("d", dd);
      var cls = "vision-cone";
      if (cam.mobile) cls += " mobile-cone";
      if (cam.id === activeCamId) cls += " active-cone";
      path.setAttribute("class", cls);
      g.appendChild(path);
    });
  }

  // Mobile camera trail
  function drawMobileTrail(camId, g) {
    if (!_data || !_data.timesteps) return;
    var trailSteps = Math.min(60, _step);
    if (trailSteps < 2) return;
    for (var i = 0; i < trailSteps; i++) {
      var si = _step - trailSteps + i;
      if (si < 0) continue;
      var frame = _data.timesteps[si];
      if (!frame || !frame.camera_positions || !frame.camera_positions[camId]) continue;
      var cp = frame.camera_positions[camId];
      var s = w2s(cp.position[0], cp.position[1]);
      var opacity = 0.05 + 0.25 * (i / trailSteps);
      var dot = ns("circle");
      dot.setAttribute("cx", s.x); dot.setAttribute("cy", s.y);
      dot.setAttribute("r", 1.5);
      dot.setAttribute("fill", "rgba(244,114,182," + opacity + ")");
      dot.setAttribute("class", "mobile-trail");
      g.appendChild(dot);
    }
  }

  function drawCameras(cameras, activeCamId) {
    var g = document.getElementById("cameras-layer");
    var tip = document.getElementById("tooltip");
    g.innerHTML = "";

    // Mobile trails first
    cameras.forEach(function (baseCam) {
      if (baseCam.mobile) drawMobileTrail(baseCam.id, g);
    });

    cameras.forEach(function (baseCam) {
      var cam = getCamAtStep(baseCam.id, _step);
      if (!cam) return;
      var s = w2s(cam.position[0], cam.position[1]);
      var isActive = cam.id === activeCamId;
      var isMobile = !!cam.mobile;

      var h = (cam.heading || 0) * Math.PI / 180;
      var sz = isActive ? 12 : 8;
      // heading direction in SVG space — derived via w2s so heading-up rotation is applied
      var fwd = w2s(cam.position[0] + Math.cos(h), cam.position[1] + Math.sin(h));
      var dLen = Math.sqrt((fwd.x - s.x) * (fwd.x - s.x) + (fwd.y - s.y) * (fwd.y - s.y)) || 1;
      var hdx = (fwd.x - s.x) / dLen, hdy = (fwd.y - s.y) / dLen;
      var perpX = -hdy, perpY = hdx;

      var tipPt = { x: s.x + hdx * sz * 1.5, y: s.y + hdy * sz * 1.5 };
      var left  = { x: s.x - hdx * sz * 0.5 + perpX * sz * 0.5, y: s.y - hdy * sz * 0.5 + perpY * sz * 0.5 };
      var right = { x: s.x - hdx * sz * 0.5 - perpX * sz * 0.5, y: s.y - hdy * sz * 0.5 - perpY * sz * 0.5 };

      var fillCol, strokeCol;
      if (isMobile) {
        fillCol = isActive ? MOBILE_COLOR : "rgba(244,114,182,0.5)";
        strokeCol = isActive ? "#f9a8d4" : "rgba(244,114,182,0.3)";
      } else {
        fillCol = isActive ? "#6366f1" : "#4b4b6b";
        strokeCol = isActive ? "#818cf8" : "rgba(99,102,241,0.3)";
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
      path.setAttribute("class", "camera-marker");
      if (isActive) {
        var glow = isMobile
          ? "drop-shadow(0 0 6px rgba(244,114,182,0.5))"
          : "drop-shadow(0 0 6px rgba(99,102,241,0.5))";
        path.setAttribute("filter", glow);
      }
      (function (cid) {
        path.addEventListener("click", function () { setCam(cid); });
      })(cam.id);

      // Tooltip
      (function (c, mob) {
        path.addEventListener("mouseenter", function (e) {
          tip.innerHTML =
            "<strong>" + c.id + (mob ? " (mobile)" : "") + "</strong><br>" +
            "Pos: " + c.position[0].toFixed(1) + ", " + c.position[1].toFixed(1) + " m<br>" +
            "<span class='meta'>Heading: " + (typeof c.heading === "number" ? c.heading.toFixed(0) : c.heading) + "&deg; &mdash; click to select</span>";
          tip.classList.add("visible"); posTip(tip, e);
        });
        path.addEventListener("mouseleave", function () { tip.classList.remove("visible"); });
        path.addEventListener("mousemove", function (e) { posTip(tip, e); });
      })(cam, isMobile);

      g.appendChild(path);

      // Camera label
      var lbl = ns("text");
      lbl.setAttribute("x", s.x); lbl.setAttribute("y", s.y + (isActive ? 22 : 18));
      lbl.setAttribute("text-anchor", "middle");
      var lblCol = isMobile
        ? (isActive ? "rgba(244,114,182,0.9)" : "rgba(244,114,182,0.5)")
        : (isActive ? "rgba(160,160,255,0.95)" : "rgba(120,120,180,0.6)");
      lbl.setAttribute("fill", lblCol);
      lbl.setAttribute("font-size", isActive ? "11" : "10");
      lbl.setAttribute("font-weight", isActive ? "600" : "400");
      lbl.setAttribute("class", "label");
      lbl.textContent = cam.id;
      g.appendChild(lbl);
    });
  }

  // ────────────────────────────────────────────────
  //  People: staleness-colored + occluded + estimated
  // ────────────────────────────────────────────────
  function drawTracks(persons, feed, activeCam, walls, simNow) {
    var gTracks = document.getElementById("tracks-layer");
    var gLines  = document.getElementById("estimation-lines-layer");
    var gLabels = document.getElementById("labels-layer");
    var tip     = document.getElementById("tooltip");
    gTracks.innerHTML = "";
    gLines.innerHTML = "";
    gLabels.innerHTML = "";

    persons.forEach(function (p) {
      var pid = p.id;
      var pos = p.position;
      var visible = p.visible;
      var seenBy = p.seen_by || [];
      var lastPos = p.last_seen_position;
      var lastTime = p.last_seen_time;

      if (visible) {
        // Green dot at real position
        var svgP = w2s(pos[0], pos[1]);
        var circle = ns("circle");
        circle.setAttribute("cx", svgP.x); circle.setAttribute("cy", svgP.y);
        circle.setAttribute("r", 13);
        circle.setAttribute("fill", "#22c55e");
        circle.setAttribute("stroke", "rgba(0,0,0,0.3)"); circle.setAttribute("stroke-width", 1);
        circle.setAttribute("class", "track-circle");

        (function (pp, sb) {
          circle.addEventListener("mouseenter", function (e) {
            tip.innerHTML =
              "<strong>Person " + pp.id + "</strong><br>" +
              "Position: " + pp.position[0].toFixed(2) + ", " + pp.position[1].toFixed(2) + " m<br>" +
              "<span class='meta'>Seen by: " + sb.join(", ") + "</span>";
            tip.classList.add("visible"); posTip(tip, e);
          });
          circle.addEventListener("mouseleave", function () { tip.classList.remove("visible"); });
          circle.addEventListener("mousemove", function (e) { posTip(tip, e); });
        })(p, seenBy);
        gTracks.appendChild(circle);

        // Label
        var lbl = ns("text");
        lbl.setAttribute("x", svgP.x); lbl.setAttribute("y", svgP.y - 20);
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("fill", "rgba(255,255,255,0.9)");
        lbl.setAttribute("font-size", "11"); lbl.setAttribute("font-weight", "600");
        lbl.setAttribute("class", "label");
        lbl.textContent = "P" + pid;
        gLabels.appendChild(lbl);
      } else {
        // ── Occluded ──
        // Gray dot at real position
        var realSvg = w2s(pos[0], pos[1]);
        var grayC = ns("circle");
        grayC.setAttribute("cx", realSvg.x); grayC.setAttribute("cy", realSvg.y);
        grayC.setAttribute("r", 11);
        grayC.setAttribute("class", "track-circle track-real");

        (function (pp) {
          grayC.addEventListener("mouseenter", function (e) {
            tip.innerHTML =
              "<strong>Person " + pp.id + " &middot; Real position (occluded)</strong><br>" +
              "<span class='meta'>" + pp.position[0].toFixed(2) + ", " + pp.position[1].toFixed(2) + " m<br>No camera has line-of-sight</span>";
            tip.classList.add("visible"); posTip(tip, e);
          });
          grayC.addEventListener("mouseleave", function () { tip.classList.remove("visible"); });
          grayC.addEventListener("mousemove", function (e) { posTip(tip, e); });
        })(p);
        gTracks.appendChild(grayC);

        // Label inside gray dot
        var grayLbl = ns("text");
        grayLbl.setAttribute("x", realSvg.x); grayLbl.setAttribute("y", realSvg.y + 4);
        grayLbl.setAttribute("text-anchor", "middle");
        grayLbl.setAttribute("fill", "rgba(200,200,210,0.85)");
        grayLbl.setAttribute("font-size", "10"); grayLbl.setAttribute("pointer-events", "none");
        grayLbl.textContent = "P" + pid;
        gTracks.appendChild(grayLbl);

        // Stale dot at last-seen position (color-coded by age)
        if (lastPos != null) {
          var age = (lastTime != null) ? simNow - lastTime : 999;
          var sColor = staleColor(lastTime != null ? lastTime : 0, simNow);
          var staleSvg = w2s(lastPos[0], lastPos[1]);
          var staleC = ns("circle");
          staleC.setAttribute("cx", staleSvg.x); staleC.setAttribute("cy", staleSvg.y);
          staleC.setAttribute("r", 13);
          staleC.setAttribute("fill", sColor);
          staleC.setAttribute("stroke", "#666"); staleC.setAttribute("stroke-width", 1);
          staleC.setAttribute("stroke-dasharray", "4,3");
          staleC.setAttribute("class", "track-circle stale-dot");

          (function (pp, ageVal, lp) {
            staleC.addEventListener("mouseenter", function (e) {
              tip.innerHTML =
                "<strong>Person " + pp.id + " &middot; Last seen</strong><br>" +
                lp[0].toFixed(2) + ", " + lp[1].toFixed(2) + " m<br>" +
                "<span class='meta'>Last seen " + ageVal.toFixed(1) + "s ago</span>";
              tip.classList.add("visible"); posTip(tip, e);
            });
            staleC.addEventListener("mouseleave", function () { tip.classList.remove("visible"); });
            staleC.addEventListener("mousemove", function (e) { posTip(tip, e); });
          })(p, age, lastPos);
          gTracks.appendChild(staleC);

          // Label above stale dot
          var staleLbl = ns("text");
          staleLbl.setAttribute("x", staleSvg.x); staleLbl.setAttribute("y", staleSvg.y - 20);
          staleLbl.setAttribute("text-anchor", "middle");
          staleLbl.setAttribute("fill", "rgba(255,255,255,0.7)");
          staleLbl.setAttribute("font-size", "10"); staleLbl.setAttribute("font-weight", "600");
          staleLbl.setAttribute("class", "label");
          staleLbl.textContent = "P" + pid;
          gLabels.appendChild(staleLbl);
        }
      }
    });

    // ── Estimated positions from selected camera's feed ──
    if (!feed || !feed.detections) return;
    feed.detections.forEach(function (d) {
      var col = PERSON_COLORS[(d.person_id - 1) % PERSON_COLORS.length];

      var es = w2s(d.estimated_position[0], d.estimated_position[1]);
      var eDot = ns("circle");
      eDot.setAttribute("cx", es.x); eDot.setAttribute("cy", es.y);
      eDot.setAttribute("r", 5);
      eDot.setAttribute("fill", "rgba(245,158,11,0.5)");
      eDot.setAttribute("stroke", col);
      eDot.setAttribute("stroke-width", 1.5);
      eDot.setAttribute("stroke-dasharray", "3,2");
      eDot.setAttribute("class", "estimated-dot");
      gTracks.appendChild(eDot);

      // Error line
      var as = w2s(d.actual_position[0], d.actual_position[1]);
      if (d.error_m > 0.05) {
        var errCol = d.error_m < 0.5 ? "#22c55e" : d.error_m < 1.5 ? "#eab308" : "#ef4444";
        var errLine = ns("line");
        errLine.setAttribute("x1", as.x); errLine.setAttribute("y1", as.y);
        errLine.setAttribute("x2", es.x); errLine.setAttribute("y2", es.y);
        errLine.setAttribute("stroke", errCol); errLine.setAttribute("stroke-width", 1.5);
        errLine.setAttribute("class", "error-line");
        gLines.appendChild(errLine);
      }

      // Uncertainty ring
      var uncR = d.uncertainty_m * pxPerM();
      if (uncR > 3) {
        var unc = ns("circle");
        unc.setAttribute("cx", es.x); unc.setAttribute("cy", es.y);
        unc.setAttribute("r", uncR);
        unc.setAttribute("fill", "none");
        unc.setAttribute("stroke", "rgba(245,158,11,0.12)");
        unc.setAttribute("stroke-width", 1);
        unc.setAttribute("stroke-dasharray", "4,3");
        gTracks.appendChild(unc);
      }
    });
  }

  // ────────────────────────────────────────────────
  //  Pipeline fused tracks (diamond overlay)
  // ────────────────────────────────────────────────
  var FUSED_COLOR_VIS   = "#06b6d4";  // cyan — visible
  var FUSED_COLOR_STALE = "#0e7490";  // darker cyan — last-seen

  function drawFusedTracks(fusedTracks, simNow) {
    var g = document.getElementById("fused-tracks-layer");
    var tip = document.getElementById("tooltip");
    g.innerHTML = "";
    if (!fusedTracks || !fusedTracks.length) return;

    fusedTracks.forEach(function (ft) {
      var pos = ft.position;
      var vis = ft.visible;
      var age = simNow - ft.last_seen;
      var s = w2s(pos[0], pos[1]);
      var sz = vis ? 9 : 7;

      // Diamond = rotated square
      var pts = [
        (s.x) + "," + (s.y - sz),
        (s.x + sz) + "," + (s.y),
        (s.x) + "," + (s.y + sz),
        (s.x - sz) + "," + (s.y),
      ].join(" ");

      var poly = ns("polygon");
      poly.setAttribute("points", pts);

      if (vis) {
        poly.setAttribute("fill", FUSED_COLOR_VIS);
        poly.setAttribute("stroke", "#22d3ee");
        poly.setAttribute("stroke-width", 1.5);
        poly.setAttribute("opacity", "0.9");
      } else {
        poly.setAttribute("fill", "rgba(6,182,212,0.25)");
        poly.setAttribute("stroke", FUSED_COLOR_STALE);
        poly.setAttribute("stroke-width", 1.2);
        poly.setAttribute("stroke-dasharray", "3,2");
        poly.setAttribute("opacity", Math.max(0.3, 1.0 - age * 0.08).toString());
      }
      poly.style.cursor = "pointer";
      poly.setAttribute("class", "fused-diamond");

      // Tooltip
      (function (f, a) {
        var mp = f.matched_person;
        var matchLabel = mp ? "P" + mp : "T" + f.id;
        var errInfo = (f.match_error != null) ? "  err: " + f.match_error.toFixed(2) + "m" : "";
        poly.addEventListener("mouseenter", function (e) {
          var status = f.visible
            ? "VISIBLE &middot; conf " + (f.confidence * 100).toFixed(0) + "%"
            : "LAST SEEN " + a.toFixed(1) + "s ago";
          tip.innerHTML =
            "<strong style='color:#22d3ee'>Pipeline " + matchLabel + "</strong> (track " + f.id + ")<br>" +
            "Fused est: (" + f.position[0].toFixed(2) + ", " + f.position[1].toFixed(2) + ") m" + errInfo + "<br>" +
            status + "<br>" +
            "<span class='meta'>Sources: " + (f.source_cameras || []).join(", ") + "</span>";
          tip.classList.add("visible"); posTip(tip, e);
        });
        poly.addEventListener("mouseleave", function () { tip.classList.remove("visible"); });
        poly.addEventListener("mousemove", function (e) { posTip(tip, e); });
      })(ft, age);

      g.appendChild(poly);

      // Label — use matched person ID for easy comparison
      var labelText = ft.matched_person ? "P" + ft.matched_person : "T" + ft.id;
      var lbl = ns("text");
      lbl.setAttribute("x", s.x); lbl.setAttribute("y", s.y - sz - 5);
      lbl.setAttribute("text-anchor", "middle");
      lbl.setAttribute("fill", vis ? "rgba(34,211,238,0.85)" : "rgba(34,211,238,0.45)");
      lbl.setAttribute("font-size", "9"); lbl.setAttribute("font-weight", "600");
      lbl.setAttribute("class", "label");
      lbl.textContent = labelText + (vis ? "" : " \u23F1");
      g.appendChild(lbl);
    });
  }

  // ════════════════════════════════════════════════
  //  MINI-MAP (full-room overview inset)
  // ════════════════════════════════════════════════

  var MM_W = 240, MM_H = 200, MM_PAD = 14;
  var mmScaleX = (MM_W - 2 * MM_PAD) / (WORLD_X[1] - WORLD_X[0]);
  var mmScaleY = (MM_H - 2 * MM_PAD) / (WORLD_Y[1] - WORLD_Y[0]);
  var mmScale  = Math.min(mmScaleX, mmScaleY);

  /** World → mini-map pixel (fixed, north-up, full room) */
  function mm(wx, wy) {
    return {
      x: MM_PAD + (wx - WORLD_X[0]) * mmScale,
      y: MM_H - MM_PAD - (wy - WORLD_Y[0]) * mmScale,
    };
  }

  function drawMiniMap(cameras, activeCamId, walls, persons, feed, simNow, fusedTracks) {
    // ── Grid & room outline ──
    var gGrid = document.getElementById("mm-grid");
    gGrid.innerHTML = "";
    var corners = [
      [WORLD_X[0], WORLD_Y[0]], [WORLD_X[1], WORLD_Y[0]],
      [WORLD_X[1], WORLD_Y[1]], [WORLD_X[0], WORLD_Y[1]]
    ];
    var pts = corners.map(function (c) { return mm(c[0], c[1]); });
    var dd = "M " + pts[0].x + " " + pts[0].y;
    for (var i = 1; i < pts.length; i++) dd += " L " + pts[i].x + " " + pts[i].y;
    dd += " Z";
    var room = ns("path"); room.setAttribute("d", dd);
    room.setAttribute("fill", "rgba(40,40,60,0.15)");
    room.setAttribute("stroke", "rgba(100,100,140,0.25)");
    room.setAttribute("stroke-width", "0.8");
    gGrid.appendChild(room);

    // Grid every 2m
    for (var gx = WORLD_X[0]; gx <= WORLD_X[1]; gx += 2) {
      var a = mm(gx, WORLD_Y[0]), b = mm(gx, WORLD_Y[1]);
      var ln = ns("line");
      ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
      ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
      ln.setAttribute("stroke", "rgba(80,80,120,0.06)"); ln.setAttribute("stroke-width", "0.5");
      gGrid.appendChild(ln);
    }
    for (var gy = WORLD_Y[0]; gy <= WORLD_Y[1]; gy += 2) {
      var a2 = mm(WORLD_X[0], gy), b2 = mm(WORLD_X[1], gy);
      var ln2 = ns("line");
      ln2.setAttribute("x1", a2.x); ln2.setAttribute("y1", a2.y);
      ln2.setAttribute("x2", b2.x); ln2.setAttribute("y2", b2.y);
      ln2.setAttribute("stroke", "rgba(80,80,120,0.06)"); ln2.setAttribute("stroke-width", "0.5");
      gGrid.appendChild(ln2);
    }

    // ── Walls ──
    var gWalls = document.getElementById("mm-walls");
    gWalls.innerHTML = "";
    (walls || []).forEach(function (w) {
      var wa = mm(w[0][0], w[0][1]), wb = mm(w[1][0], w[1][1]);
      var wl = ns("line");
      wl.setAttribute("x1", wa.x); wl.setAttribute("y1", wa.y);
      wl.setAttribute("x2", wb.x); wl.setAttribute("y2", wb.y);
      wl.setAttribute("stroke", "rgba(180,180,200,0.35)");
      wl.setAttribute("stroke-width", "1.5"); wl.setAttribute("stroke-linecap", "round");
      gWalls.appendChild(wl);
    });

    // ── FOV cone (active camera only) ──
    var gFov = document.getElementById("mm-fov");
    gFov.innerHTML = "";
    var activeCam = getCamAtStep(activeCamId, _step);
    if (activeCam) {
      var cx = activeCam.position[0], cy = activeCam.position[1];
      var h = (activeCam.heading || 0) * Math.PI / 180;
      var mmHalfFov = activeCam.hfov_deg ? (activeCam.hfov_deg / 2) * Math.PI / 180 : HALF_FOV;
      var a1 = h - mmHalfFov, a2 = h + mmHalfFov;
      var fovPts = [];
      for (var fi = 0; fi <= 30; fi++) {
        var t = fi / 30;
        var fa = a1 + t * (a2 - a1);
        var fx = cx + 50 * Math.cos(fa), fy = cy + 50 * Math.sin(fa);
        var hit = rayFirstWall(cx, cy, fx, fy, walls);
        var ex, ey;
        if (hit) {
          var ddx = hit.x - cx, ddy = hit.y - cy;
          var dist = Math.sqrt(ddx * ddx + ddy * ddy);
          if (dist < CONE_R) { ex = cx + ddx * 0.999; ey = cy + ddy * 0.999; }
          else { ex = cx + CONE_R * Math.cos(fa); ey = cy + CONE_R * Math.sin(fa); }
        } else {
          ex = cx + CONE_R * Math.cos(fa); ey = cy + CONE_R * Math.sin(fa);
        }
        fovPts.push(mm(ex, ey));
      }
      var cPx = mm(cx, cy);
      var fd = "M " + cPx.x + " " + cPx.y;
      for (var fj = 0; fj < fovPts.length; fj++) fd += " L " + fovPts[fj].x + " " + fovPts[fj].y;
      fd += " Z";
      var fovPath = ns("path"); fovPath.setAttribute("d", fd);
      var isMob = activeCam.mobile;
      fovPath.setAttribute("fill", isMob ? "rgba(244,114,182,0.12)" : "rgba(99,102,241,0.12)");
      fovPath.setAttribute("stroke", isMob ? "rgba(244,114,182,0.25)" : "rgba(99,102,241,0.25)");
      fovPath.setAttribute("stroke-width", "0.6");
      gFov.appendChild(fovPath);
    }

    // ── Tracks (persons + estimates) ──
    var gTracks = document.getElementById("mm-tracks");
    gTracks.innerHTML = "";
    (persons || []).forEach(function (p) {
      var col = PERSON_COLORS[(p.id - 1) % PERSON_COLORS.length];
      var sc = staleColor(p.last_t || 0, simNow);
      var sp = mm(p.position[0], p.position[1]);
      var dot = ns("circle");
      dot.setAttribute("cx", sp.x); dot.setAttribute("cy", sp.y);
      dot.setAttribute("r", 3);
      dot.setAttribute("fill", sc); dot.setAttribute("stroke", "rgba(255,255,255,0.2)");
      dot.setAttribute("stroke-width", "0.5");
      gTracks.appendChild(dot);
    });
    // Estimated positions
    if (feed && feed.detections) {
      feed.detections.forEach(function (d) {
        var es = mm(d.estimated_position[0], d.estimated_position[1]);
        var as2 = mm(d.actual_position[0], d.actual_position[1]);
        // Error line
        if (d.error_m > 0.05) {
          var errCol = d.error_m < 0.5 ? "#22c55e" : d.error_m < 1.5 ? "#eab308" : "#ef4444";
          var el2 = ns("line");
          el2.setAttribute("x1", as2.x); el2.setAttribute("y1", as2.y);
          el2.setAttribute("x2", es.x); el2.setAttribute("y2", es.y);
          el2.setAttribute("stroke", errCol); el2.setAttribute("stroke-width", "0.8");
          el2.setAttribute("stroke-dasharray", "2,2");
          gTracks.appendChild(el2);
        }
        // Estimated dot
        var eDot = ns("circle");
        eDot.setAttribute("cx", es.x); eDot.setAttribute("cy", es.y);
        eDot.setAttribute("r", 2.5);
        eDot.setAttribute("fill", "rgba(245,158,11,0.6)");
        eDot.setAttribute("stroke", "rgba(245,158,11,0.3)"); eDot.setAttribute("stroke-width", "0.5");
        gTracks.appendChild(eDot);
      });
    }

    // ── Fused pipeline diamonds on minimap ──
    (fusedTracks || []).forEach(function (ft) {
      var fp = mm(ft.position[0], ft.position[1]);
      var sz = ft.visible ? 4 : 3;
      var pts = [
        fp.x + "," + (fp.y - sz),
        (fp.x + sz) + "," + fp.y,
        fp.x + "," + (fp.y + sz),
        (fp.x - sz) + "," + fp.y,
      ].join(" ");
      var d = ns("polygon");
      d.setAttribute("points", pts);
      d.setAttribute("fill", ft.visible ? "rgba(6,182,212,0.8)" : "rgba(6,182,212,0.25)");
      d.setAttribute("stroke", ft.visible ? "#22d3ee" : "#0e7490");
      d.setAttribute("stroke-width", "0.6");
      if (!ft.visible) d.setAttribute("stroke-dasharray", "2,1");
      gTracks.appendChild(d);
    });

    // ── Camera markers ──
    var gCams = document.getElementById("mm-cameras");
    gCams.innerHTML = "";
    cameras.forEach(function (baseCam) {
      var cam = getCamAtStep(baseCam.id, _step);
      if (!cam) return;
      var s = mm(cam.position[0], cam.position[1]);
      var isActive = cam.id === activeCamId;
      var isMobile = !!cam.mobile;
      var h2 = (cam.heading || 0) * Math.PI / 180;
      var sz = isActive ? 6 : 4;
      // Direction (north-up, no rotation needed)
      var hdx2 = Math.cos(h2) * mmScale;
      var hdy2 = -Math.sin(h2) * mmScale;
      var len2 = Math.sqrt(hdx2 * hdx2 + hdy2 * hdy2) || 1;
      hdx2 /= len2; hdy2 /= len2;
      var px2 = -hdy2, py2 = hdx2;

      var tipPt = { x: s.x + hdx2 * sz * 1.3, y: s.y + hdy2 * sz * 1.3 };
      var left  = { x: s.x - hdx2 * sz * 0.4 + px2 * sz * 0.4, y: s.y - hdy2 * sz * 0.4 + py2 * sz * 0.4 };
      var right = { x: s.x - hdx2 * sz * 0.4 - px2 * sz * 0.4, y: s.y - hdy2 * sz * 0.4 - py2 * sz * 0.4 };

      var fillC = isMobile
        ? (isActive ? MOBILE_COLOR : "rgba(244,114,182,0.5)")
        : (isActive ? "#6366f1" : "#4b4b6b");
      var strokeC = isMobile
        ? (isActive ? "#f9a8d4" : "rgba(244,114,182,0.2)")
        : (isActive ? "#818cf8" : "rgba(99,102,241,0.2)");

      var tri = ns("path");
      tri.setAttribute("d",
        "M " + tipPt.x + " " + tipPt.y +
        " L " + left.x + " " + left.y +
        " L " + right.x + " " + right.y + " Z"
      );
      tri.setAttribute("fill", fillC);
      tri.setAttribute("stroke", strokeC);
      tri.setAttribute("stroke-width", isActive ? 1.2 : 0.6);
      tri.style.cursor = "pointer";
      (function (cid) {
        tri.addEventListener("click", function () { setCam(cid); });
      })(cam.id);
      gCams.appendChild(tri);
    });

    // ── Viewport indicator (shows what the main map is looking at) ──
    var gVp = document.getElementById("mm-viewport");
    gVp.innerHTML = "";
    var scale = pxPerM();
    var halfWm = (VIEW_W / 2) / scale;
    var halfHm = (VIEW_H / 2) / scale;

    if (_headingUp) {
      // Draw a rotated rectangle
      var hRad = _viewHeading * Math.PI / 180;
      var cosH = Math.cos(hRad), sinH = Math.sin(hRad);
      // Four corners in world space
      var vc = [
        [-halfWm, -halfHm], [halfWm, -halfHm],
        [halfWm, halfHm], [-halfWm, halfHm]
      ];
      var rotA = Math.PI / 2 - hRad;
      var vpPts = vc.map(function (v) {
        // Inverse of the heading-up rotation: rotate back
        var rx = v[0] * Math.cos(rotA) + v[1] * Math.sin(rotA);
        var ry = -v[0] * Math.sin(rotA) + v[1] * Math.cos(rotA);
        return mm(_viewCx + rx, _viewCy + ry);
      });
      var vpD = "M " + vpPts[0].x + " " + vpPts[0].y;
      for (var vi = 1; vi < vpPts.length; vi++) vpD += " L " + vpPts[vi].x + " " + vpPts[vi].y;
      vpD += " Z";
      var vpRect = ns("path"); vpRect.setAttribute("d", vpD);
      vpRect.setAttribute("class", "mm-viewport");
      gVp.appendChild(vpRect);
    } else {
      // Axis-aligned rectangle
      var tl = mm(_viewCx - halfWm, _viewCy + halfHm);
      var br = mm(_viewCx + halfWm, _viewCy - halfHm);
      var vpR = ns("rect");
      vpR.setAttribute("x", tl.x); vpR.setAttribute("y", tl.y);
      vpR.setAttribute("width", br.x - tl.x); vpR.setAttribute("height", br.y - tl.y);
      vpR.setAttribute("class", "mm-viewport");
      gVp.appendChild(vpR);
    }
  }

  // ════════════════════════════════════════════════
  //  MAIN RENDER
  // ════════════════════════════════════════════════

  function render() {
    if (!_data || !_camId) return;
    var cam = getCam(_camId);
    if (!cam) return;

    // Centre the overhead map on the active camera + track heading
    _viewCx = cam.position[0];
    _viewCy = cam.position[1];
    _viewHeading = cam.heading || 0;

    var walls       = _data.walls || [];
    var ts          = _data.timesteps || [];
    var frame       = ts[_step] || { persons: [], camera_feeds: {}, fused_tracks: [] };
    var persons     = frame.persons || [];
    var fusedTracks = frame.fused_tracks || [];
    var feed        = (frame.camera_feeds || {})[_camId] || null;
    var simNow      = frame.t || 0;

    // Camera feed (canvas)
    drawFeed(cam, feed);
    updateFeedInfo(cam, feed);
    updateDetectionList(feed);

    // Overhead map (SVG)
    drawGrid();
    drawWalls(walls);
    drawVisionCones(_data.cameras || [], _camId, walls);
    drawTracks(persons, feed, cam, walls, simNow);
    drawFusedTracks(fusedTracks, simNow);
    drawCameras(_data.cameras || [], _camId);

    // Mini-map (full room inset) — skip in live mode
    if (!_liveMode) {
      drawMiniMap(_data.cameras || [], _camId, walls, persons, feed, simNow, fusedTracks);
    }
  }

  // ════════════════════════════════════════════════
  //  CONTROLS
  // ════════════════════════════════════════════════

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

  document.addEventListener("keydown", function (e) {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " " || e.code === "Space") {
      e.preventDefault();
      document.getElementById("play-pause").click();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault(); setStep(_step - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault(); setStep(_step + 1);
    } else if (e.key >= "1" && e.key <= "9") {
      var idx = parseInt(e.key, 10) - 1;
      if (_data && _data.cameras && idx < _data.cameras.length)
        setCam(_data.cameras[idx].id);
    } else if (e.key === "r" || e.key === "R") {
      toggleHeadingUp();
    }
  });

  // ── Heading-up toggle ───────────────────────────
  function toggleHeadingUp() {
    _headingUp = !_headingUp;
    var btn = document.getElementById("heading-toggle");
    if (btn) {
      btn.textContent = _headingUp ? "\uD83E\uDDED Heading Up" : "\uD83E\uDDED North Up";
      btn.classList.toggle("active", _headingUp);
    }
    render();
  }

  document.getElementById("heading-toggle").addEventListener("click", function (e) {
    e.preventDefault();
    toggleHeadingUp();
  });

  // ════════════════════════════════════════════════
  //  LIVE MODE — polls /api/live from live_fusion.py
  // ════════════════════════════════════════════════

  function startLiveMode() {
    _liveMode = true;

    // Hide simulation-only UI
    var timeline = document.querySelector(".timeline");
    if (timeline) timeline.style.display = "none";

    var mmWrap = document.getElementById("minimap-wrap");
    if (mmWrap) mmWrap.style.display = "none";

    // Hide the camera-feed panel (no simulated feed in live mode)
    var feedPanel = document.querySelector(".feed-panel");
    if (feedPanel) feedPanel.style.display = "none";

    // Update header
    var h1 = document.querySelector("header h1");
    if (h1) h1.innerHTML = 'Fusion map <span style="color:#22d3ee;font-size:0.6em;vertical-align:middle;margin-left:6px;letter-spacing:1px">LIVE</span>';

    document.getElementById("status").textContent = "Waiting for cameras\u2026";

    pollLive();
    _liveTimer = setInterval(pollLive, 200);
  }

  function pollLive() {
    fetch("/api/live")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var cams = d.cameras || [];
        var tracks = d.fused_tracks || [];

        // Status text
        if (cams.length === 0) {
          document.getElementById("status").textContent = "Waiting for cameras\u2026";
        } else {
          var nVis = 0;
          for (var ti = 0; ti < tracks.length; ti++) if (tracks[ti].visible) nVis++;
          document.getElementById("status").textContent =
            cams.length + " camera" + (cams.length !== 1 ? "s" : "") +
            " \u00B7 " + nVis + " tracked" +
            (tracks.length - nVis > 0 ? " \u00B7 " + (tracks.length - nVis) + " last-seen" : "");
        }

        // Wrap live data into the format the render functions expect
        _data = {
          cameras: cams,
          walls: d.walls || [],
          timesteps: [{
            t: d.timestamp || 0,
            persons: [],           // no ground truth in live mode
            fused_tracks: tracks,
            camera_feeds: {},
            camera_positions: {},
          }],
        };
        _step = 0;

        // Camera tabs
        if (cams.length > 0) {
          if (!_camId || !cams.some(function (c) { return c.id === _camId; })) {
            _camId = cams[0].id;
          }
          buildTabs(cams);
        }

        render();
      })
      .catch(function () {
        // Silent — will retry on next interval
      });
  }

  // ────────────────────────────────────────────────
  //  Boot — detect live mode, fall back to simulation
  // ────────────────────────────────────────────────
  fetch("/api/live")
    .then(function (r) {
      if (!r.ok) throw new Error("not available");
      return r.json();
    })
    .then(function (d) {
      if (d.mode === "live") {
        startLiveMode();
      } else {
        fetchData();
      }
    })
    .catch(function () {
      fetchData();
    });
})();
