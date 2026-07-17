import * as THREE from "three";

/* =========================================================================
   WEBSLINGER — a single-scene Three.js web-swinging / combat demo
   inspired by the traversal loop of Insomniac's Spider-Man games.

   Physics note: instead of pulling in a full physics engine (Cannon/Rapier),
   swinging uses a hand-rolled Verlet-style rope constraint. Each frame we
   integrate gravity + air control into velocity, predict the next position,
   then clamp that position onto the sphere defined by the web anchor and
   rope length. Recomputing velocity from the *constrained* displacement is
   what produces the classic pendulum acceleration at the bottom of the arc
   "for free" — no explicit force-based solver needed. This keeps the whole
   thing dependency-free and easy to tune. (The architecture below isolates
   this in `updateSwingPhysics`, so swapping in Rapier later only means
   replacing that one function and the wall/roof collision resolver.)
   ========================================================================= */

/* ---------------------------- Global constants -------------------------- */
const GRAVITY = -34;
const PLAYER_RADIUS = 0.45;
const PLAYER_HEIGHT = 1.8;
const GROUND_Y = 0;
const MAX_WEB_DISTANCE = 85;
const MIN_ANCHOR_HEIGHT_ABOVE = 4;
const SWING_AIR_CONTROL = 22;
const FALL_AIR_CONTROL = 14;
const MELEE_RANGE = 3.4;
const ZIP_RANGE = 45;
const ZIP_SPEED = 46;
const ZIP_HIT_RANGE = 2.2;
const CITY_HALF = 5; // grid goes from -CITY_HALF..CITY_HALF
const BLOCK_SPACING = 26;

/* ------------------------------- Renderer -------------------------------- */
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fd4ff);
scene.fog = new THREE.Fog(0x9fd4ff, 90, 420);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 6, 12);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* -------------------------------- Lights ---------------------------------- */
const hemi = new THREE.HemisphereLight(0xbfe3ff, 0x2b2b33, 0.9);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff2d6, 1.4);
sun.position.set(120, 180, 80);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -180;
sun.shadow.camera.right = 180;
sun.shadow.camera.top = 180;
sun.shadow.camera.bottom = -180;
sun.shadow.camera.far = 500;
sun.shadow.bias = -0.0005;
scene.add(sun);

/* --------------------------- Shared textures ------------------------------ */
function buildWindowTexture() {
  const c = document.createElement("canvas");
  c.width = 128; c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#232733";
  ctx.fillRect(0, 0, c.width, c.height);
  const cols = 6, rows = 12;
  const cw = c.width / cols, ch = c.height / rows;
  for (let r = 0; r < rows; r++) {
    for (let cIdx = 0; cIdx < cols; cIdx++) {
      const lit = Math.random() < 0.35;
      ctx.fillStyle = lit ? "rgba(255,214,120,0.9)" : "rgba(140,160,190,0.35)";
      ctx.fillRect(cIdx * cw + cw * 0.18, r * ch + ch * 0.22, cw * 0.64, ch * 0.56);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
const windowTex = buildWindowTexture();

function buildGroundTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#3a3d44";
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 2;
  for (let i = 0; i <= 256; i += 32) {
    ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 256); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(256, i); ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  return tex;
}
const groundMat = new THREE.MeshStandardMaterial({ map: buildGroundTexture(), roughness: 1 });
const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), groundMat);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/* ------------------------------ City grid --------------------------------- */
const buildings = []; // { minX,maxX,minY,maxY,minZ,maxZ, mesh }
const buildingMeshes = [];

const buildingPalette = [0x8a8f9c, 0x9c8a7c, 0x7c8a9c, 0xa39a8a, 0x8f97a3, 0x7a7f8c];

function generateCity() {
  for (let i = -CITY_HALF; i <= CITY_HALF; i++) {
    for (let j = -CITY_HALF; j <= CITY_HALF; j++) {
      // leave a plus-shaped clearing near spawn
      if (Math.abs(i) <= 1 && Math.abs(j) <= 1) continue;
      if (Math.random() < 0.12) continue; // occasional plaza / gap

      const w = 9 + Math.random() * 8;
      const d = 9 + Math.random() * 8;
      const h = 14 + Math.random() * 70;
      const cx = i * BLOCK_SPACING + (Math.random() - 0.5) * 4;
      const cz = j * BLOCK_SPACING + (Math.random() - 0.5) * 4;

      const mat = new THREE.MeshStandardMaterial({
        map: windowTex,
        color: buildingPalette[Math.floor(Math.random() * buildingPalette.length)],
        roughness: 0.85,
        metalness: 0.05,
      });
      mat.map = windowTex.clone();
      mat.map.needsUpdate = true;
      mat.map.repeat.set(Math.max(1, Math.round(w / 4)), Math.max(1, Math.round(h / 4)));

      const geo = new THREE.BoxGeometry(w, h, d);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(cx, h / 2, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      scene.add(mesh);
      buildingMeshes.push(mesh);

      buildings.push({
        minX: cx - w / 2, maxX: cx + w / 2,
        minY: 0, maxY: h,
        minZ: cz - d / 2, maxZ: cz + d / 2,
        mesh,
      });
    }
  }
}
generateCity();

/* ------------------------------- Player ------------------------------------ */
// Procedural low-poly "suited hero" — red torso/head, blue limbs, simple
// webbed-pattern via vertex colors substitute (flat colors keep perf high).
function buildHeroMesh() {
  const group = new THREE.Group();

  const redMat = new THREE.MeshStandardMaterial({ color: 0xc41e2e, roughness: 0.55, metalness: 0.1 });
  const blueMat = new THREE.MeshStandardMaterial({ color: 0x1c3fae, roughness: 0.5, metalness: 0.15 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), redMat);
  torso.position.y = 1.05;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 16), redMat);
  head.position.y = 1.55;
  head.castShadow = true;
  group.add(head);

  // eyes (simple white lenses)
  const lensMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x222222 });
  const lensGeo = new THREE.SphereGeometry(0.06, 8, 8);
  const lensL = new THREE.Mesh(lensGeo, lensMat); lensL.position.set(-0.09, 1.58, 0.19); group.add(lensL);
  const lensR = new THREE.Mesh(lensGeo, lensMat); lensR.position.set(0.09, 1.58, 0.19); group.add(lensR);

  function limb(len, mat) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, len, 3, 6), mat);
    m.castShadow = true;
    return m;
  }

  const armL = new THREE.Group();
  const armLMesh = limb(0.5, blueMat); armLMesh.position.y = -0.25;
  armL.add(armLMesh);
  armL.position.set(-0.42, 1.32, 0);
  group.add(armL);

  const armR = new THREE.Group();
  const armRMesh = limb(0.5, blueMat); armRMesh.position.y = -0.25;
  armR.add(armRMesh);
  armR.position.set(0.42, 1.32, 0);
  group.add(armR);

  const legL = new THREE.Group();
  const legLMesh = limb(0.6, blueMat); legLMesh.position.y = -0.3;
  legL.add(legLMesh);
  legL.position.set(-0.15, 0.7, 0);
  group.add(legL);

  const legR = new THREE.Group();
  const legRMesh = limb(0.6, blueMat); legRMesh.position.y = -0.3;
  legR.add(legRMesh);
  legR.position.set(0.15, 0.7, 0);
  group.add(legR);

  return { group, torso, head, armL, armR, legL, legR };
}

const hero = buildHeroMesh();
scene.add(hero.group);

/* ------------------------------ Player state -------------------------------- */
const player = {
  position: new THREE.Vector3(0, PLAYER_HEIGHT / 2 + 0.1, 4),
  velocity: new THREE.Vector3(0, 0, 0),
  state: "falling", // 'ground' | 'falling' | 'swinging' | 'zipping'
  anchor: null,
  ropeLength: 0,
  facing: new THREE.Vector3(0, 0, -1),
  yaw: Math.PI,
  pitch: -0.15,
  attackCooldown: 0,
  zipTarget: null,
  onWallSlide: false,
};

/* --------------------------------- Web line ---------------------------------- */
const webLineGeo = new THREE.BufferGeometry();
const webLinePositions = new Float32Array(3 * 16);
webLineGeo.setAttribute("position", new THREE.BufferAttribute(webLinePositions, 3));
const webLineMat = new THREE.LineBasicMaterial({ color: 0xf5f5f5, transparent: true, opacity: 0.9 });
const webLine = new THREE.Line(webLineGeo, webLineMat);
webLine.visible = false;
webLine.frustumCulled = false;
scene.add(webLine);

const zipLineMat = new THREE.LineBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.85 });
const zipLine = new THREE.Line(webLineGeo.clone(), zipLineMat);
zipLine.visible = false;
zipLine.frustumCulled = false;
scene.add(zipLine);

function updateWebLine(line, from, to, sagAmount, t) {
  const positions = line.geometry.attributes.position.array;
  const segs = positions.length / 3;
  const mid = new THREE.Vector3().lerpVectors(from, to, 0.5);
  mid.y -= sagAmount;
  const curve = new THREE.QuadraticBezierCurve3(from, mid, to);
  const pts = curve.getPoints(segs - 1);
  for (let i = 0; i < segs; i++) {
    positions[i * 3] = pts[i].x;
    positions[i * 3 + 1] = pts[i].y;
    positions[i * 3 + 2] = pts[i].z;
  }
  line.geometry.attributes.position.needsUpdate = true;
}

/* -------------------------------- Enemies ------------------------------------- */
const enemies = [];
let totalSpawned = 0;
let totalDefeated = 0;

function buildEnemyMesh() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x5a5f68, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.7, 4, 8), mat);
  body.position.y = 1.0;
  body.castShadow = true;
  group.add(body);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.22, 12, 12), mat);
  head.position.y = 1.55;
  head.castShadow = true;
  group.add(head);
  return group;
}

function spawnWave() {
  const rooftops = buildings.filter((b) => b.maxY > 10);
  if (rooftops.length === 0) return;

  const chosenRoofs = [];
  const tries = 6;
  for (let i = 0; i < tries; i++) {
    const b = rooftops[Math.floor(Math.random() * rooftops.length)];
    if (!chosenRoofs.includes(b)) chosenRoofs.push(b);
  }

  chosenRoofs.forEach((roof) => {
    const groupSize = 1 + Math.floor(Math.random() * 3);
    for (let k = 0; k < groupSize; k++) {
      const mesh = buildEnemyMesh();
      const px = THREE.MathUtils.lerp(roof.minX + 1, roof.maxX - 1, Math.random());
      const pz = THREE.MathUtils.lerp(roof.minZ + 1, roof.maxZ - 1, Math.random());
      mesh.position.set(px, roof.maxY, pz);
      scene.add(mesh);

      const enemy = {
        mesh,
        health: 3,
        alive: true,
        roof,
        patrolA: new THREE.Vector3(roof.minX + 1, roof.maxY, roof.minZ + 1),
        patrolB: new THREE.Vector3(roof.maxX - 1, roof.maxY, roof.maxZ - 1),
        patrolT: Math.random(),
        patrolDir: 1,
        hitFlash: 0,
      };
      enemies.push(enemy);
      totalSpawned++;
    }
  });
}
spawnWave();

/* --------------------------------- Input ------------------------------------- */
const keys = { w: false, a: false, s: false, d: false, space: false };
let mouseDown = false;
let isPointerLocked = false;
let isPaused = false;
let gameStarted = false;

window.addEventListener("keydown", (e) => {
  if (e.code === "KeyW") keys.w = true;
  if (e.code === "KeyA") keys.a = true;
  if (e.code === "KeyS") keys.s = true;
  if (e.code === "KeyD") keys.d = true;
  if (e.code === "Space") { keys.space = true; onSpacePressed(); e.preventDefault(); }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "KeyW") keys.w = false;
  if (e.code === "KeyA") keys.a = false;
  if (e.code === "KeyS") keys.s = false;
  if (e.code === "KeyD") keys.d = false;
  if (e.code === "Space") keys.space = false;
});

canvas.addEventListener("mousedown", (e) => {
  if (!isPointerLocked || isPaused) return;
  if (e.button === 0) { mouseDown = true; onLeftClick(); }
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) { mouseDown = false; onLeftRelease(); }
});

window.addEventListener("mousemove", (e) => {
  if (!isPointerLocked || isPaused) return;
  const sensitivity = 0.0022;
  player.yaw -= e.movementX * sensitivity;
  player.pitch -= e.movementY * sensitivity;
  player.pitch = THREE.MathUtils.clamp(player.pitch, -1.1, 1.0);
});

/* ------------------------------ Pointer lock / fullscreen ---------------------- */
const startOverlay = document.getElementById("startOverlay");
const pauseOverlay = document.getElementById("pauseOverlay");
const playBtn = document.getElementById("playBtn");
const resumeBtn = document.getElementById("resumeBtn");
const hudEls = ["topLeftHud", "topRightHud", "minimapWrap", "controlsHud"].map((id) => document.getElementById(id));

function enterGame() {
  const el = document.documentElement;
  if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
  canvas.requestPointerLock();
}

playBtn.addEventListener("click", () => {
  gameStarted = true;
  isPaused = false;
  startOverlay.classList.add("hidden");
  hudEls.forEach((h) => h.classList.remove("hidden"));
  enterGame();
});

resumeBtn.addEventListener("click", () => {
  enterGame();
});

document.addEventListener("pointerlockchange", () => {
  isPointerLocked = document.pointerLockElement === canvas;
  if (!gameStarted) return;
  if (!isPointerLocked) {
    isPaused = true;
    pauseOverlay.classList.remove("hidden");
  } else {
    isPaused = false;
    pauseOverlay.classList.add("hidden");
  }
});

/* --------------------------------- Combat actions -------------------------------- */
function nearestAliveEnemy(maxDist, requireAngle) {
  let best = null, bestDist = Infinity;
  const camForward = new THREE.Vector3();
  camera.getWorldDirection(camForward);
  for (const e of enemies) {
    if (!e.alive) continue;
    const d = e.mesh.position.distanceTo(player.position);
    if (d > maxDist) continue;
    if (requireAngle) {
      const toEnemy = new THREE.Vector3().subVectors(e.mesh.position, camera.position).normalize();
      if (toEnemy.dot(camForward) < 0.72) continue;
    }
    if (d < bestDist) { bestDist = d; best = e; }
  }
  return best;
}

function damageEnemy(enemy, knockDir) {
  enemy.health -= 1;
  enemy.hitFlash = 0.15;
  enemy.mesh.position.addScaledVector(knockDir, 1.3);
  if (enemy.health <= 0 && enemy.alive) {
    enemy.alive = false;
    totalDefeated++;
    updateScoreHud();
    // simple defeat animation: sink + fade via scale
    const startScale = enemy.mesh.scale.clone();
    let t = 0;
    const anim = () => {
      t += 0.045;
      const s = Math.max(0, 1 - t);
      enemy.mesh.scale.set(startScale.x * s, startScale.y * s, startScale.z * s);
      enemy.mesh.position.y -= 0.02;
      if (t < 1) requestAnimationFrame(anim);
      else scene.remove(enemy.mesh);
    };
    anim();
    checkWaveCleared();
  }
}

function castAnchorRay() {
  const raycaster = new THREE.Raycaster();
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  // bias the ray upward a bit so it's easy to find rooftops/ledges above
  dir.y += 0.28;
  dir.normalize();
  raycaster.set(camera.position, dir);
  raycaster.far = MAX_WEB_DISTANCE;
  const hits = raycaster.intersectObjects(buildingMeshes, false);
  for (const hit of hits) {
    if (hit.point.y > player.position.y + MIN_ANCHOR_HEIGHT_ABOVE) {
      return hit.point.clone();
    }
  }
  return null;
}

function startSwing(anchor) {
  player.anchor = anchor;
  player.ropeLength = player.position.distanceTo(anchor);
  player.state = "swinging";
  webLine.visible = true;
}

function cutSwing(launchBoostY) {
  player.state = "falling";
  player.anchor = null;
  webLine.visible = false;
  if (launchBoostY) player.velocity.y += launchBoostY;
}

function onLeftClick() {
  if (isPaused) return;

  // Priority 1: web-zip attack while swinging/falling and enemy targeted
  if (player.state === "swinging" || player.state === "falling") {
    const target = nearestAliveEnemy(ZIP_RANGE, true);
    if (target) {
      player.state = "zipping";
      player.zipTarget = target;
      player.anchor = null;
      webLine.visible = false;
      playAttackPose();
      return;
    }
  }

  // Priority 2: melee if grounded (or airborne) and close to an enemy
  const meleeTarget = nearestAliveEnemy(MELEE_RANGE, false);
  if (meleeTarget && player.attackCooldown <= 0) {
    player.attackCooldown = 0.4;
    const knockDir = new THREE.Vector3().subVectors(meleeTarget.mesh.position, player.position);
    knockDir.y = 0; knockDir.normalize();
    damageEnemy(meleeTarget, knockDir);
    playAttackPose();
    return;
  }

  // Priority 3: shoot a web to start swinging (works whether grounded or airborne)
  if (player.state !== "swinging") {
    const anchor = castAnchorRay();
    if (anchor) {
      startSwing(anchor);
    } else {
      flashCenterPrompt("NO ANCHOR POINT ABOVE");
    }
  }
}

function onLeftRelease() {
  if (player.state === "swinging") {
    cutSwing(0); // retain velocity, classic swing-release launch
  }
}

function onSpacePressed() {
  if (isPaused) return;
  if (player.state === "swinging") {
    cutSwing(11); // jump boost out of the swing
  } else if (player.state === "ground") {
    player.velocity.y = 10.5;
    player.state = "falling";
  }
}

let attackPoseT = 0;
function playAttackPose() { attackPoseT = 1; }

/* ------------------------------- HUD helpers -------------------------------- */
const scoreValEl = document.getElementById("scoreVal");
const stateValEl = document.getElementById("stateVal");
const speedValEl = document.getElementById("speedVal");
const centerPromptEl = document.getElementById("centerPrompt");
const missionBannerEl = document.getElementById("missionBanner");
const crosshairEl = document.getElementById("crosshair");

let promptTimer = 0;
function flashCenterPrompt(text) {
  centerPromptEl.textContent = text;
  centerPromptEl.classList.remove("hidden");
  promptTimer = 1.4;
}

function updateScoreHud() {
  scoreValEl.textContent = String(totalDefeated);
}

function checkWaveCleared() {
  const remaining = enemies.some((e) => e.alive);
  if (!remaining) {
    missionBannerEl.classList.remove("hidden");
    setTimeout(() => {
      missionBannerEl.classList.add("hidden");
      spawnWave();
    }, 2200);
  }
}

/* -------------------------------- Collision helpers -------------------------------- */
function findSupportingRoof(x, z) {
  // returns building whose footprint (expanded slightly) contains x,z
  for (const b of buildings) {
    if (x > b.minX - PLAYER_RADIUS && x < b.maxX + PLAYER_RADIUS &&
        z > b.minZ - PLAYER_RADIUS && z < b.maxZ + PLAYER_RADIUS) {
      return b;
    }
  }
  return null;
}

function resolveBuildingCollisions(dt) {
  for (const b of buildings) {
    const expMinX = b.minX - PLAYER_RADIUS, expMaxX = b.maxX + PLAYER_RADIUS;
    const expMinZ = b.minZ - PLAYER_RADIUS, expMaxZ = b.maxZ + PLAYER_RADIUS;
    const px = player.position.x, pz = player.position.z, py = player.position.y;

    const insideXZ = px > expMinX && px < expMaxX && pz > expMinZ && pz < expMaxZ;
    if (!insideXZ) continue;

    const feetY = py - PLAYER_HEIGHT / 2;

    // Landing on rooftop: falling downward, feet were above roof last frame
    if (feetY <= b.maxY && feetY > b.maxY - 1.2 && player.velocity.y <= 0) {
      player.position.y = b.maxY + PLAYER_HEIGHT / 2;
      player.velocity.y = 0;
      player.velocity.x *= 0.85;
      player.velocity.z *= 0.85;
      if (player.state !== "ground") player.state = "ground";
      player.onWallSlide = false;
      continue;
    }

    // Otherwise, if we're horizontally inside the footprint and below the roof line,
    // we're colliding with a wall face -> push out along shallowest axis & slide.
    if (feetY < b.maxY - 1.2 && feetY > b.minY) {
      const distToMinX = px - expMinX, distToMaxX = expMaxX - px;
      const distToMinZ = pz - expMinZ, distToMaxZ = expMaxZ - pz;
      const minPen = Math.min(distToMinX, distToMaxX, distToMinZ, distToMaxZ);

      if (minPen === distToMinX) { player.position.x = expMinX; player.velocity.x = Math.min(player.velocity.x, 0); }
      else if (minPen === distToMaxX) { player.position.x = expMaxX; player.velocity.x = Math.max(player.velocity.x, 0); }
      else if (minPen === distToMinZ) { player.position.z = expMinZ; player.velocity.z = Math.min(player.velocity.z, 0); }
      else { player.position.z = expMaxZ; player.velocity.z = Math.max(player.velocity.z, 0); }

      // wall-slide: only while actually moving into/down the wall & airborne
      if (player.state === "falling" || player.state === "swinging") {
        player.onWallSlide = true;
        player.velocity.y *= 0.86; // friction against the wall -> slide, don't free-fall
        if (player.state === "swinging") cutSwing(0);
        player.state = "falling";
      }
    }
  }
}

/* ---------------------------------- Physics update ---------------------------------- */
const tmpForward = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function airControlVector(strength) {
  camera.getWorldDirection(tmpForward);
  tmpForward.y = 0; tmpForward.normalize();
  tmpRight.crossVectors(tmpForward, UP).normalize();

  const acc = new THREE.Vector3();
  if (keys.w) acc.addScaledVector(tmpForward, 1);
  if (keys.s) acc.addScaledVector(tmpForward, -1);
  if (keys.d) acc.addScaledVector(tmpRight, 1);
  if (keys.a) acc.addScaledVector(tmpRight, -1);
  if (acc.lengthSq() > 0) acc.normalize().multiplyScalar(strength);
  return acc;
}

function updateSwingPhysics(dt) {
  // gravity + air control
  player.velocity.y += GRAVITY * dt;
  const control = airControlVector(SWING_AIR_CONTROL);
  player.velocity.addScaledVector(control, dt);

  // predicted position
  const predicted = player.position.clone().addScaledVector(player.velocity, dt);

  // rope constraint (allow a hair of stretch for an elastic feel)
  const toPredicted = new THREE.Vector3().subVectors(predicted, player.anchor);
  const dist = toPredicted.length();
  const maxLen = player.ropeLength * 1.015;
  if (dist > maxLen) {
    toPredicted.multiplyScalar(maxLen / dist);
    const constrained = new THREE.Vector3().addVectors(player.anchor, toPredicted);
    // recompute velocity from constrained displacement -> natural pendulum accel
    player.velocity.copy(constrained).sub(player.position).multiplyScalar(1 / dt);
    predicted.copy(constrained);
  }

  player.position.copy(predicted);
}

function updateZipPhysics(dt) {
  const target = player.zipTarget;
  if (!target || !target.alive) {
    player.state = "falling";
    player.zipTarget = null;
    return;
  }
  const toTarget = new THREE.Vector3().subVectors(target.mesh.position, player.position);
  const dist = toTarget.length();
  if (dist < ZIP_HIT_RANGE) {
    const knockDir = toTarget.clone().setY(0).normalize();
    damageEnemy(target, knockDir);
    player.velocity.copy(toTarget).normalize().multiplyScalar(6);
    player.state = "falling";
    player.zipTarget = null;
    return;
  }
  toTarget.normalize();
  player.velocity.copy(toTarget).multiplyScalar(ZIP_SPEED);
  player.position.addScaledVector(player.velocity, dt);
}

function updateFallPhysics(dt) {
  player.velocity.y += GRAVITY * dt;
  const control = airControlVector(FALL_AIR_CONTROL);
  player.velocity.addScaledVector(control, dt);
  player.velocity.x = THREE.MathUtils.clamp(player.velocity.x, -40, 40);
  player.velocity.z = THREE.MathUtils.clamp(player.velocity.z, -40, 40);
  player.position.addScaledVector(player.velocity, dt);
}

function updateGroundPhysics(dt) {
  const control = airControlVector(1);
  const moveSpeed = 9;
  player.velocity.x = control.x * moveSpeed;
  player.velocity.z = control.z * moveSpeed;
  player.position.addScaledVector(new THREE.Vector3(player.velocity.x, 0, player.velocity.z), dt);

  const roof = findSupportingRoof(player.position.x, player.position.z);
  const supportY = roof ? roof.maxY : GROUND_Y;
  const targetY = supportY + PLAYER_HEIGHT / 2;

  if (player.position.y > targetY + 0.05) {
    player.state = "falling";
  } else {
    player.position.y = targetY;
    player.velocity.y = 0;
  }
}

function checkGroundedLanding() {
  const roof = findSupportingRoof(player.position.x, player.position.z);
  const supportY = roof ? roof.maxY : GROUND_Y;
  const feetY = player.position.y - PLAYER_HEIGHT / 2;
  if (feetY <= supportY + 0.05 && player.velocity.y <= 0) {
    player.position.y = supportY + PLAYER_HEIGHT / 2;
    player.velocity.set(player.velocity.x * 0.8, 0, player.velocity.z * 0.8);
    player.state = "ground";
    player.onWallSlide = false;
  }
  if (player.position.y < -30) {
    // fell off the world -> respawn near start
    player.position.set(0, PLAYER_HEIGHT / 2 + 8, 4);
    player.velocity.set(0, 0, 0);
    player.state = "falling";
  }
}

/* ----------------------------------- Camera ------------------------------------- */
const camOffset = new THREE.Vector3();
function updateCamera(dt) {
  const dist = 7.5;
  const height = 2.6;
  camOffset.set(
    Math.sin(player.yaw) * Math.cos(player.pitch) * dist,
    height + Math.sin(player.pitch) * dist * 0.6,
    Math.cos(player.yaw) * Math.cos(player.pitch) * dist
  );
  const desired = new THREE.Vector3().copy(player.position).add(camOffset);
  camera.position.lerp(desired, 1 - Math.pow(0.001, dt));

  const lookTarget = new THREE.Vector3().copy(player.position);
  lookTarget.y += 0.8;
  camera.lookAt(lookTarget);
}

/* --------------------------------- Hero pose/animation ---------------------------------- */
let idleT = 0;
function updateHeroVisual(dt) {
  hero.group.position.copy(player.position);
  hero.group.position.y -= PLAYER_HEIGHT / 2;
  hero.group.rotation.y = player.yaw;

  idleT += dt;

  if (attackPoseT > 0) {
    attackPoseT -= dt * 3.2;
    const t = Math.max(0, attackPoseT);
    hero.armR.rotation.x = -Math.PI * 0.6 * Math.sin(t * Math.PI);
  } else {
    hero.armR.rotation.x = THREE.MathUtils.lerp(hero.armR.rotation.x, 0, 0.2);
  }

  if (player.state === "swinging") {
    // pendulum tilt: lean into the swing based on tangential velocity
    const lean = THREE.MathUtils.clamp(-player.velocity.x * 0.03, -0.6, 0.6);
    hero.group.rotation.z = THREE.MathUtils.lerp(hero.group.rotation.z, lean, 0.2);
    hero.torso.rotation.x = THREE.MathUtils.lerp(hero.torso.rotation.x, -0.35, 0.15);
    hero.armL.rotation.x = THREE.MathUtils.lerp(hero.armL.rotation.x, -2.4, 0.2);
    if (attackPoseT <= 0) hero.armR.rotation.x = THREE.MathUtils.lerp(hero.armR.rotation.x, -2.4, 0.2);
    hero.legL.rotation.x = THREE.MathUtils.lerp(hero.legL.rotation.x, 0.5, 0.15);
    hero.legR.rotation.x = THREE.MathUtils.lerp(hero.legR.rotation.x, -0.3, 0.15);
  } else if (player.state === "falling" || player.state === "zipping") {
    hero.group.rotation.z = THREE.MathUtils.lerp(hero.group.rotation.z, 0, 0.15);
    hero.torso.rotation.x = THREE.MathUtils.lerp(hero.torso.rotation.x, 0.1, 0.15);
    hero.armL.rotation.z = THREE.MathUtils.lerp(hero.armL.rotation.z, -1.2, 0.15);
    hero.armR.rotation.z = THREE.MathUtils.lerp(hero.armR.rotation.z, 1.2, 0.15);
    hero.armL.rotation.x = THREE.MathUtils.lerp(hero.armL.rotation.x, -0.2, 0.15);
    hero.legL.rotation.x = THREE.MathUtils.lerp(hero.legL.rotation.x, -0.2, 0.1);
    hero.legR.rotation.x = THREE.MathUtils.lerp(hero.legR.rotation.x, 0.2, 0.1);
  } else {
    // idle / ground
    hero.group.rotation.z = THREE.MathUtils.lerp(hero.group.rotation.z, 0, 0.2);
    hero.torso.rotation.x = THREE.MathUtils.lerp(hero.torso.rotation.x, 0, 0.15);
    const bob = Math.sin(idleT * 2.4) * 0.06;
    hero.armL.rotation.x = THREE.MathUtils.lerp(hero.armL.rotation.x, bob, 0.1);
    hero.armL.rotation.z = THREE.MathUtils.lerp(hero.armL.rotation.z, 0, 0.1);
    hero.armR.rotation.z = THREE.MathUtils.lerp(hero.armR.rotation.z, 0, 0.1);
    hero.legL.rotation.x = THREE.MathUtils.lerp(hero.legL.rotation.x, 0, 0.1);
    hero.legR.rotation.x = THREE.MathUtils.lerp(hero.legR.rotation.x, 0, 0.1);

    const moving = keys.w || keys.a || keys.s || keys.d;
    if (moving) {
      const walk = Math.sin(idleT * 10) * 0.5;
      hero.legL.rotation.x = walk;
      hero.legR.rotation.x = -walk;
      hero.armL.rotation.x = -walk * 0.6;
      if (attackPoseT <= 0) hero.armR.rotation.x = walk * 0.6;
    }
  }
}

/* ---------------------------------- Enemy AI --------------------------------------- */
function updateEnemies(dt) {
  for (const e of enemies) {
    if (!e.alive) continue;
    e.patrolT += dt * 0.15 * e.patrolDir;
    if (e.patrolT > 1) { e.patrolT = 1; e.patrolDir = -1; }
    if (e.patrolT < 0) { e.patrolT = 0; e.patrolDir = 1; }
    const target = new THREE.Vector3().lerpVectors(e.patrolA, e.patrolB, e.patrolT);
    e.mesh.position.x = THREE.MathUtils.lerp(e.mesh.position.x, target.x, 0.02);
    e.mesh.position.z = THREE.MathUtils.lerp(e.mesh.position.z, target.z, 0.02);

    const distToPlayer = e.mesh.position.distanceTo(player.position);
    if (distToPlayer < 18) {
      const dir = new THREE.Vector3().subVectors(player.position, e.mesh.position);
      const angle = Math.atan2(dir.x, dir.z);
      e.mesh.rotation.y = angle;
    }

    if (e.hitFlash > 0) {
      e.hitFlash -= dt;
      e.mesh.children.forEach((c) => c.material && (c.material.emissive = new THREE.Color(0xff2222)));
    } else {
      e.mesh.children.forEach((c) => c.material && c.material.emissive && (c.material.emissive = new THREE.Color(0x000000)));
    }
  }
}

/* ---------------------------------- Minimap ----------------------------------------- */
const minimapCanvas = document.getElementById("minimap");
const mmCtx = minimapCanvas.getContext("2d");
const MM_SIZE = 180;
const MM_RANGE = 160; // world units visible radius

function worldToMinimap(x, z) {
  const relX = x - player.position.x;
  const relZ = z - player.position.z;
  // rotate so player's facing is "up" on the minimap
  const cos = Math.cos(-player.yaw), sin = Math.sin(-player.yaw);
  const rx = relX * cos - relZ * sin;
  const rz = relX * sin + relZ * cos;
  return {
    x: MM_SIZE / 2 + (rx / MM_RANGE) * (MM_SIZE / 2),
    y: MM_SIZE / 2 + (rz / MM_RANGE) * (MM_SIZE / 2),
  };
}

function drawMinimap() {
  mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);
  mmCtx.save();
  mmCtx.beginPath();
  mmCtx.arc(MM_SIZE / 2, MM_SIZE / 2, MM_SIZE / 2, 0, Math.PI * 2);
  mmCtx.clip();
  mmCtx.fillStyle = "#11141b";
  mmCtx.fillRect(0, 0, MM_SIZE, MM_SIZE);

  mmCtx.fillStyle = "rgba(150,160,180,0.55)";
  for (const b of buildings) {
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    const p = worldToMinimap(cx, cz);
    if (p.x < -10 || p.x > MM_SIZE + 10 || p.y < -10 || p.y > MM_SIZE + 10) continue;
    const w = ((b.maxX - b.minX) / MM_RANGE) * (MM_SIZE / 2);
    const d = ((b.maxZ - b.minZ) / MM_RANGE) * (MM_SIZE / 2);
    mmCtx.save();
    mmCtx.translate(p.x, p.y);
    mmCtx.rotate(-player.yaw);
    mmCtx.fillRect(-w / 2, -d / 2, w, d);
    mmCtx.restore();
  }

  for (const e of enemies) {
    if (!e.alive) continue;
    const p = worldToMinimap(e.mesh.position.x, e.mesh.position.z);
    mmCtx.fillStyle = "#ef4444";
    mmCtx.beginPath();
    mmCtx.arc(p.x, p.y, 3.2, 0, Math.PI * 2);
    mmCtx.fill();
  }

  // player marker (always center, pointing up)
  mmCtx.fillStyle = "#60a5fa";
  mmCtx.beginPath();
  mmCtx.moveTo(MM_SIZE / 2, MM_SIZE / 2 - 6);
  mmCtx.lineTo(MM_SIZE / 2 - 5, MM_SIZE / 2 + 5);
  mmCtx.lineTo(MM_SIZE / 2 + 5, MM_SIZE / 2 + 5);
  mmCtx.closePath();
  mmCtx.fill();

  mmCtx.restore();
  mmCtx.strokeStyle = "rgba(255,255,255,0.15)";
  mmCtx.beginPath();
  mmCtx.arc(MM_SIZE / 2, MM_SIZE / 2, MM_SIZE / 2 - 1, 0, Math.PI * 2);
  mmCtx.stroke();
}

/* --------------------------------------- HUD updates ---------------------------------------- */
function updateStatusHud() {
  const stateLabel = {
    ground: "GROUND", falling: "AIRBORNE", swinging: "SWINGING", zipping: "WEB-ZIP",
  }[player.state] || player.state.toUpperCase();
  stateValEl.textContent = stateLabel;
  const speed = Math.hypot(player.velocity.x, player.velocity.y, player.velocity.z);
  speedValEl.textContent = `${speed.toFixed(0)} u/s`;

  const target = nearestAliveEnemy(Math.max(ZIP_RANGE, MELEE_RANGE), player.state !== "ground");
  crosshairEl.classList.toggle("locked-on", !!target);
}

/* ------------------------------------------ Main loop ----------------------------------------- */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (gameStarted && !isPaused) {
    if (player.attackCooldown > 0) player.attackCooldown -= dt;
    if (promptTimer > 0) {
      promptTimer -= dt;
      if (promptTimer <= 0) centerPromptEl.classList.add("hidden");
    }

    switch (player.state) {
      case "swinging":
        updateSwingPhysics(dt);
        resolveBuildingCollisions(dt);
        checkGroundedLanding();
        break;
      case "zipping":
        updateZipPhysics(dt);
        resolveBuildingCollisions(dt);
        checkGroundedLanding();
        break;
      case "falling":
        updateFallPhysics(dt);
        resolveBuildingCollisions(dt);
        checkGroundedLanding();
        break;
      case "ground":
      default:
        updateGroundPhysics(dt);
        break;
    }

    if (player.state === "swinging" && player.anchor) {
      const handPos = player.position.clone(); handPos.y += 0.9;
      updateWebLine(webLine, handPos, player.anchor, player.ropeLength * 0.08, idleT);
      zipLine.visible = false;
    } else if (player.state === "zipping" && player.zipTarget) {
      const handPos = player.position.clone(); handPos.y += 0.9;
      zipLine.visible = true;
      updateWebLine(zipLine, handPos, player.zipTarget.mesh.position, 0.3, idleT);
      webLine.visible = false;
    } else {
      webLine.visible = false;
      zipLine.visible = false;
    }

    updateEnemies(dt);
    updateHeroVisual(dt);
    updateCamera(dt);
    updateStatusHud();
    drawMinimap();
  }

  renderer.render(scene, camera);
}

animate();
