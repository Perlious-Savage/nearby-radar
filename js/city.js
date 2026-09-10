// The 3D city: real OpenStreetMap geometry for Jumeirah Beach Residence, lit as
// late afternoon so the Gulf, the sand and the skyline are legible at a glance
// rather than a field of grey boxes.
//
// Everything is merged aggressively. All 634 buildings are ONE geometry, all
// 199 roads are one, and the whole scene runs in a handful of draw calls.
//
// Polygon triangulation uses THREE.ShapeUtils from core, so nothing beyond
// three itself has to be vendored.

import * as THREE from '../vendor/three.module.min.js';

const UP = new THREE.Vector3(0, 1, 0);
const ease = t => 1 - Math.pow(1 - t, 3);

// Ground stack. Everything is flat, so these tiny offsets are what decide what
// covers what. Sea is the floor; buildings start at zero.
const Y = { sea: -1.4, land: -0.9, water: -0.6, beach: -0.45, park: -0.3, road: -0.15 };

const C = {
  sky: 0x9fc4e8, horizon: 0xf6c98a, haze: 0xe9b98a,
  sea: 0x2e93bf, seaDeep: 0x1d6f96,
  land: 0xbfae95, sand: 0xe8d3ad, park: 0x6f8f5a, road: 0xd8cdbb,
  sun: 0xffd9a0, bounce: 0x6f5a45,
};

export class City {
  constructor(canvas, data) {
    this.data = data;
    this.spots = data.spots;
    this.onPick = () => {};

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(C.haze, 3200, 13000);

    this.camera = new THREE.PerspectiveCamera(46, 1, 1, 16000);

    // Orbit state: the camera looks at `target` from `orbit` radians around it
    // at `pitch` and `dist`. Every camera move animates those three numbers.
    this.target = new THREE.Vector3(0, 0, 0);
    this.orbit = 2.35;      // opens out over the water, looking back at the beach
    this.pitch = 0.30;
    this.dist = 2100;
    this.drift = true;
    this.tween = null;

    this.buildSky();
    this.buildLights();
    this.buildGround();
    this.buildCity();
    this.buildWheel();
    this.buildMarkers();
    this.buildYou();

    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.bindInput(canvas);

    this.clock = new THREE.Clock();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  // Vertex-coloured dome. Cheaper and sharper than a texture, and it gives the
  // horizon the warm band that sells the hour.
  buildSky() {
    const geo = new THREE.SphereGeometry(9000, 32, 20);
    const top = new THREE.Color(C.sky), low = new THREE.Color(C.horizon);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      const t = Math.max(0, Math.min(1, (pos.getY(i) / 9000 + 0.08) / 0.55));
      c.copy(low).lerp(top, Math.pow(t, 0.75));
      col.set([c.r, c.g, c.b], i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false,
    })));
    this.scene.background = new THREE.Color(C.horizon);
  }

  buildLights() {
    // Low sun out over the Gulf to the north-west, which is where it actually
    // sets from this beach. x is east and z is south, so north-west is -x -z.
    const sun = new THREE.DirectionalLight(C.sun, 3.1);
    sun.position.set(-2600, 850, -1500);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 2200;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 100, far: 9000 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 1.5;
    this.scene.add(sun);

    // Warm ground bounce under a cool sky keeps shadowed faces from going flat.
    this.scene.add(new THREE.HemisphereLight(C.sky, C.bounce, 1.5));
    const fill = new THREE.DirectionalLight(0x9dbfe0, 0.5);
    fill.position.set(1800, 500, 1400);
    this.scene.add(fill);
  }

  // Flat [x0,z0,x1,z1,...] rings into one merged, triangulated, flat mesh.
  fill(rings, y, colour, receive = true) {
    const pos = [];
    for (const flat of rings) {
      const ring = [];
      for (let i = 0; i + 1 < flat.length; i += 2) ring.push(new THREE.Vector2(flat[i], flat[i + 1]));
      if (ring.length < 3) continue;
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(ring, [])) {
        for (const i of [a, b, c]) pos.push(ring[i].x, y, ring[i].y);
      }
    }
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: colour, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    }));
    mesh.receiveShadow = receive;
    this.scene.add(mesh);
  }

  buildGround() {
    const d = this.data;

    // Land is the default floor and the sea is painted on top of it, rather
    // than the other way round. If the coastline sweep below ever misses a
    // stretch, the gap shows as ordinary ground instead of putting towers out
    // in open water, which is the difference between a rough edge and a demo
    // that looks broken.
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(24000, 24000),
      new THREE.MeshStandardMaterial({ color: C.land, roughness: 1, metalness: 0 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = Y.sea;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Sea, unpacked from the land/sea bitmask that tools/bake.mjs computed by
    // asking, for every cell, which side of the NEAREST coastline segment it
    // falls on. That work is done at build time because it is the expensive,
    // fiddly part; here it is just reading bits and emitting quads.
    //
    // Rows are run-length merged, so a 220x220 grid becomes a few hundred quads
    // rather than 48,400 of them.
    const mask = d.seaMask;
    if (mask) {
      const bits = Uint8Array.from(atob(mask.bits), ch => ch.charCodeAt(0));
      const sea = (i, j) => {
        const n = j * mask.w + i;
        return (bits[n >> 3] >> (n & 7)) & 1;
      };
      const pos = [];
      for (let j = 0; j < mask.h; j++) {
        let run = -1;
        for (let i = 0; i <= mask.w; i++) {
          const wet = i < mask.w && sea(i, j);
          if (wet && run < 0) run = i;
          if (!wet && run >= 0) {
            // Overlap by half a cell so neighbouring rows leave no hairlines.
            const x1 = mask.x0 + run * mask.stepX - mask.stepX * 0.5;
            const x2 = mask.x0 + i * mask.stepX + mask.stepX * 0.5;
            const z1 = mask.z0 + j * mask.stepZ - mask.stepZ * 0.5;
            const z2 = mask.z0 + (j + 1) * mask.stepZ + mask.stepZ * 0.5;
            pos.push(x1, Y.water, z1, x2, Y.water, z1, x2, Y.water, z2);
            pos.push(x1, Y.water, z1, x2, Y.water, z2, x1, Y.water, z2);
            run = -1;
          }
        }
      }
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.computeVertexNormals();
        this.scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: C.sea, roughness: 0.42, metalness: 0.04, side: THREE.DoubleSide,
        })));
      }
    }

    this.fill(d.water || [], Y.water + 0.05, C.seaDeep, false);   // marina basins
    this.fill(d.beach || [], Y.beach, C.sand);
    this.fill(d.parks || [], Y.park, C.park);

    // Roads as flat ribbons, all merged into one mesh.
    const rpos = [];
    for (const road of d.roads || []) {
      const w = road[0] / 2;
      for (let i = 1; i + 3 < road.length; i += 2) {
        const ax = road[i], az = road[i + 1], bx = road[i + 2], bz = road[i + 3];
        const dx = bx - ax, dz = bz - az;
        const len = Math.hypot(dx, dz);
        if (!len) continue;
        const nx = (dz / len) * w, nz = (-dx / len) * w;
        rpos.push(ax + nx, Y.road, az + nz, bx + nx, Y.road, bz + nz, bx - nx, Y.road, bz - nz);
        rpos.push(ax + nx, Y.road, az + nz, bx - nx, Y.road, bz - nz, ax - nx, Y.road, az - nz);
      }
    }
    if (rpos.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(rpos, 3));
      geo.computeVertexNormals();
      this.scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        color: C.road, roughness: 0.9, metalness: 0, side: THREE.DoubleSide,
      })));
    }

    // Range rings, centred on the user, for a sense of distance.
    this.rings = new THREE.Group();
    for (let r = 250; r <= 1000; r += 250) {
      const pts = [];
      for (let i = 0; i <= 128; i++) {
        const a = (i / 128) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 1.2, Math.sin(a) * r));
      }
      this.rings.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22 })
      ));
    }
    this.scene.add(this.rings);
  }

  buildCity() {
    const pos = [], norm = [], col = [];
    const base = new THREE.Color();

    for (const b of this.data.buildings) {
      const h = b[0];
      const n = (b.length - 1) / 2;
      if (n < 3) continue;

      const ring = [];
      for (let i = 0; i < n; i++) ring.push(new THREE.Vector2(b[1 + i * 2], b[2 + i * 2]));

      let area = 0;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        area += p.x * q.y - q.x * p.y;
      }
      if (area < 0) ring.reverse();   // wind CCW so wall normals face outward

      // Dubai towers are pale sand and glass. Taller ones sit cooler and
      // lighter, which reads as distance haze without a post-process pass.
      const t = Math.min(h / 240, 1);
      base.setHSL(0.09 - t * 0.035, 0.20 - t * 0.09, 0.60 + t * 0.14);

      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        const dx = q.x - p.x, dz = q.y - p.y;
        const len = Math.hypot(dx, dz) || 1;
        const nx = dz / len, nz = -dx / len;
        const quad = [
          [p.x, 0, p.y], [q.x, 0, q.y], [q.x, h, q.y],
          [p.x, 0, p.y], [q.x, h, q.y], [p.x, h, p.y],
        ];
        for (const [x, y, z] of quad) {
          pos.push(x, y, z);
          norm.push(nx, 0, nz);
          const k = 0.72 + 0.28 * (y / Math.max(h, 1));   // grounded at the base
          col.push(base.r * k, base.g * k, base.b * k);
        }
      }

      for (const [a, bi, c] of THREE.ShapeUtils.triangulateShape(ring, [])) {
        for (const idx of [a, bi, c]) {
          pos.push(ring[idx].x, h, ring[idx].y);
          norm.push(0, 1, 0);
          col.push(base.r * 1.1, base.g * 1.1, base.b * 1.1);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(norm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.cityMesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.72, metalness: 0.08,
    }));
    this.cityMesh.castShadow = true;
    this.cityMesh.receiveShadow = true;
    this.scene.add(this.cityMesh);
  }

  // Ain Dubai. An extruded footprint renders the world's largest observation
  // wheel as a squat cylinder, so it gets built as an actual wheel.
  buildWheel() {
    const w = this.data.wheel;
    if (!w) return;

    const R = w.height * 0.45;
    const hub = w.height * 0.5;
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f4f7, roughness: 0.45, metalness: 0.35 });

    const group = new THREE.Group();
    group.position.set(w.x, 0, w.z);
    // Turn the wheel to face the beach, or it reads as a line seen edge-on.
    group.rotation.y = Math.atan2(-w.x, -w.z);

    const spin = new THREE.Group();
    spin.position.y = hub;

    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, R * 0.028, 10, 72), white);
    rim.castShadow = true;
    spin.add(rim);

    // Spokes as one line mesh, pods as one instanced mesh.
    const POD = 36;
    const pts = [];
    for (let i = 0; i < POD; i++) {
      const a = (i / POD) * Math.PI * 2;
      pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
    }
    spin.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xdfe6ee, transparent: true, opacity: 0.75 })
    ));

    const pods = new THREE.InstancedMesh(new THREE.BoxGeometry(9, 9, 11), white, POD);
    const m = new THREE.Matrix4();
    for (let i = 0; i < POD; i++) {
      const a = (i / POD) * Math.PI * 2;
      m.makeTranslation(Math.cos(a) * R, Math.sin(a) * R, 0);
      pods.setMatrixAt(i, m);
    }
    pods.castShadow = true;
    spin.add(pods);
    group.add(spin);
    this.wheelSpin = spin;

    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.035, R * 0.06, hub, 8), white);
      leg.position.set(0, hub / 2, side * hub * 0.34);
      leg.rotation.x = side * 0.32;
      leg.castShadow = true;
      group.add(leg);
    }
    this.scene.add(group);
  }

  buildMarkers() {
    const geo = new THREE.CylinderGeometry(4.5, 4.5, 1, 8, 1, true);
    geo.translate(0, 0.5, 0);   // pivot at the base so scale.y grows upward
    this.markers = new THREE.InstancedMesh(
      geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }), this.spots.length
    );
    this.markers.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(this.spots.length * 3), 3);
    this.scene.add(this.markers);

    this.caps = new THREE.InstancedMesh(
      new THREE.SphereGeometry(11, 14, 10), new THREE.MeshBasicMaterial({}), this.spots.length
    );
    this.caps.instanceColor =
      new THREE.InstancedBufferAttribute(new Float32Array(this.spots.length * 3), 3);
    this.scene.add(this.caps);

    this.pulse = new Map();   // spot id -> seconds of pulse remaining
    this.updateMarkers({}, null);
  }

  buildYou() {
    this.you = new THREE.Mesh(
      new THREE.ConeGeometry(15, 40, 4),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    );
    this.you.rotation.x = Math.PI;
    this.you.position.y = 70;
    this.scene.add(this.you);
  }

  // heat: {spotId: pinCount}. saved: Set of ids.
  updateMarkers(heat, savedSet) {
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const KIND = { food: 0xff7a3d, cafe: 0x2ea8ff, bar: 0xb45cff, event: 0x00d68f, shop: 0xffc53d };

    this.spots.forEach((s, i) => {
      const pins = heat[s.id] || 0;
      const h = 55 + pins * 30;

      m.makeScale(1, h, 1);
      m.setPosition(s.x, 0, s.z);
      this.markers.setMatrixAt(i, m);
      this.caps.setMatrixAt(i, new THREE.Matrix4().makeTranslation(s.x, h, s.z));

      c.set(KIND[s.kind] ?? 0x8899aa);
      if (savedSet?.has(s.id)) c.offsetHSL(0, 0.1, 0.1);
      const boost = this.pulse.has(s.id) ? 2.2 : pins ? 1.5 : 1;
      this.markers.setColorAt(i, c.clone().multiplyScalar(boost));
      this.caps.setColorAt(i, c.clone().multiplyScalar(boost * 1.15));
    });

    this.markers.instanceMatrix.needsUpdate = true;
    this.caps.instanceMatrix.needsUpdate = true;
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    if (this.caps.instanceColor) this.caps.instanceColor.needsUpdate = true;
  }

  ping(spotId) { this.pulse.set(spotId, 1.8); }

  setYou(x, z) {
    this.you.position.set(x, 70, z);
    this.rings.position.set(x, 0, z);
  }

  flyTo(spot) {
    this.drift = false;
    this.tween = {
      t: 0, dur: 1.3,
      from: { target: this.target.clone(), orbit: this.orbit, pitch: this.pitch, dist: this.dist },
      to: {
        target: new THREE.Vector3(spot.x, 55, spot.z),
        orbit: this.orbit + 0.8, pitch: 0.24, dist: 430,
      },
    };
  }

  pullBack() {
    this.tween = {
      t: 0, dur: 1.2,
      from: { target: this.target.clone(), orbit: this.orbit, pitch: this.pitch, dist: this.dist },
      to: {
        target: new THREE.Vector3(this.you.position.x, 0, this.you.position.z),
        orbit: this.orbit + 0.35, pitch: 0.30, dist: 2100,
      },
    };
    setTimeout(() => { this.drift = true; }, 1300);
  }

  bindInput(canvas) {
    let dragging = false, lastX = 0, lastY = 0, moved = 0;

    canvas.addEventListener('pointerdown', e => {
      dragging = true; moved = 0;
      lastX = e.clientX; lastY = e.clientY;
      this.drift = false;
      this.tween = null;
    });
    addEventListener('pointermove', e => {
      if (!dragging) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      this.orbit -= dx * 0.005;
      this.pitch = Math.max(0.06, Math.min(1.25, this.pitch + dy * 0.004));
      lastX = e.clientX; lastY = e.clientY;
    });
    addEventListener('pointerup', e => {
      if (dragging && moved < 6) this.pick(e, canvas);
      dragging = false;
    });
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      this.drift = false;
      this.dist = Math.max(200, Math.min(4200, this.dist * (1 + Math.sign(e.deltaY) * 0.12)));
    }, { passive: false });
  }

  pick(e, canvas) {
    const r = canvas.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
    this.ray.setFromCamera(this.pointer, this.camera);

    for (const mesh of [this.caps, this.markers]) {
      const hit = this.ray.intersectObject(mesh)[0];
      if (hit && hit.instanceId != null) return this.onPick(this.spots[hit.instanceId], null);
    }
    const at = new THREE.Vector3();
    if (this.ray.ray.intersectPlane(new THREE.Plane(UP, 0), at)) this.onPick(null, at);
  }

  resize() {
    const c = this.renderer.domElement;
    const w = c.clientWidth || 1, h = c.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.tween) {
      this.tween.t += dt;
      const k = ease(Math.min(this.tween.t / this.tween.dur, 1));
      const { from, to } = this.tween;
      this.target.lerpVectors(from.target, to.target, k);
      this.orbit = from.orbit + (to.orbit - from.orbit) * k;
      this.pitch = from.pitch + (to.pitch - from.pitch) * k;
      this.dist = from.dist + (to.dist - from.dist) * k;
      if (this.tween.t >= this.tween.dur) this.tween = null;
    } else if (this.drift) {
      this.orbit += dt * 0.022;
    }

    const cp = Math.cos(this.pitch);
    this.camera.position.set(
      this.target.x + Math.sin(this.orbit) * this.dist * cp,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.orbit) * this.dist * cp
    );
    this.camera.lookAt(this.target);

    // Ain Dubai turns once every 38 minutes in reality. That is invisible on
    // stage, so this runs it about 60 times faster.
    if (this.wheelSpin) this.wheelSpin.rotation.z += dt * 0.046;
    this.you.position.y = 70 + Math.sin(performance.now() / 1000 * 2.6) * 6;

    if (this.pulse.size) {
      let dirty = false;
      for (const [id, left] of this.pulse) {
        const next = left - dt;
        if (next <= 0) { this.pulse.delete(id); dirty = true; } else this.pulse.set(id, next);
      }
      if (dirty) this.repaint?.();
    }

    this.renderer.render(this.scene, this.camera);
  }
}
