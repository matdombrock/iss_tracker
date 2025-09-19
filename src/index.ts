import * as BABYLON from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import "@babylonjs/loaders";

// Check if we have a "dbg" parameter in the URL
// If so, we are in debug mode and will log to console
// Otherwise, we are in production mode and will silence console.log and console.error
// Example: http://localhost:3000/?dbg=1
const urlParams = new URLSearchParams(window.location.search);
const dbg = urlParams.get('dbg');
if (!dbg) {
  console.log = function() { };
  console.error = function() { };
}
else {
  console.log("Debug mode enabled");
}

//
// Application state
//
interface State {
  engine: BABYLON.Engine | null;
  canvas: HTMLCanvasElement | null;
  userLatitude: number;
  userLongitude: number;
  issPos: { latitude: number; longitude: number };
  issPosLast: { latitude: number; longitude: number };
  locName: string;
  distance: number;
  lastDistance: number;
  direction: string;
  timeSinceUpdate: number;
  isTracking: boolean;
  mainColor: number[];
  dataRaw: any | null;
  issMarker: any | null;
  textBlock: any | null;
  titleBlock: any | null;
}

let state: State = {
  canvas: null,
  engine: null,
  userLatitude: 47.608013, // Default: Seattle
  userLongitude: -122.335167,
  issPos: { latitude: 99, longitude: 99 },
  issPosLast: { latitude: 99, longitude: 99 },
  locName: "ocean",
  distance: 0,
  lastDistance: 0,
  direction: "???",
  timeSinceUpdate: 0,
  isTracking: false,
  mainColor: [0, 1, 1],
  dataRaw: null,
  issMarker: null,
  textBlock: null,
  titleBlock: null,
};

//
// Shaders
//
BABYLON.Effect.ShadersStore["scanlineFragmentShader"] = `
  precision highp float;
  varying vec2 vUV;
  uniform sampler2D textureSampler;
  uniform float time;
  void main(void) {
    vec4 color = texture2D(textureSampler, vUV);
    float scanline = sin((vUV.y + time * 0.2) * 800.0) * 0.08;
    color.rgb -= scanline;
    gl_FragColor = color;
  }
`;

BABYLON.Effect.ShadersStore["gradientVertexShader"] = `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  uniform mat4 worldViewProjection;
  varying vec2 vUV;
  void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    vUV = uv;
  }
`;

BABYLON.Effect.ShadersStore["gradientFragmentShader"] = `
  precision highp float;
  varying vec2 vUV;
  uniform float time;
  void main(void) {
    float time2 = time * 0.77;
    float size = 1000.0;
    float x = sin(vUV.x * size * sin(time/8.0));
    float y = cos(vUV.y * size * cos(time/8.0));
    x = (x + 1.0) * 0.5;
    y = (y + 1.0) * 0.5;
    float r = 0.0;
    float g = y + sin(time) * cos(time2);
    float b =  x + cos(time) * sin(time2);
    float bright = 0.05;
    r *= bright;
    g *= bright;
    b *= bright;
    gl_FragColor = vec4(r, g, b, 1.0);
  }
`;

//
// Utility functions
//
class Util {
  // Convert latitude and longitude to Cartesian coordinates on a sphere
  latLongToCartesian(latitude: number, longitude: number, radius: number = 1) {
    const latRad = latitude * Math.PI / 180;
    const lonRad = (longitude + 180) * Math.PI / 180;
    const x = radius * Math.cos(latRad) * Math.cos(lonRad);
    const y = radius * Math.sin(latRad);
    const z = radius * Math.cos(latRad) * Math.sin(lonRad);
    return { x, y, z };
  }
  // Request user location using the Geolocation API
  requestUserLocation() {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        console.log("User position obtained:");
        console.log(position.coords.latitude, position.coords.longitude);
        state.userLatitude = position.coords.latitude;
        state.userLongitude = position.coords.longitude;
      },
      (error) => {
        console.error(error);
      }
    )
  }
  focusOnISS() {
    if (state.engine === null) return;
    const scene = state.engine.scenes[0];
    const camera = scene.activeCamera as BABYLON.ArcRotateCamera;
    const earthRadius = 1;
    const issAltitude = state.dataRaw ? state.dataRaw.altitude : 0;
    const issRadius = earthRadius + (issAltitude / 6371);
    const pos = util.latLongToCartesian(state.issPos.latitude, state.issPos.longitude, issRadius);
    const target = new BABYLON.Vector3(pos.x, pos.y, pos.z);

    // Calculate spherical coordinates for the ISS position
    const r = target.length();
    const theta = Math.acos(target.y / r); // polar angle
    const phi = Math.atan2(target.z, target.x); // azimuthal angle

    // Animate camera angles and target
    const animFrames = 120;
    const startAlpha = camera.alpha;
    const startBeta = camera.beta;
    const startRadius = camera.radius;
    const startTarget = camera.target.clone();

    let frame = 0;
    function lerpCamera() {
      frame++;
      const t = Math.min(frame / animFrames, 1);
      // Lerp angles (handling wrap-around for alpha)
      let deltaAlpha = phi - startAlpha;
      if (deltaAlpha > Math.PI) deltaAlpha -= 2 * Math.PI;
      if (deltaAlpha < -Math.PI) deltaAlpha += 2 * Math.PI;
      camera.alpha = startAlpha + deltaAlpha * t;
      camera.beta = startBeta + (theta - startBeta) * t;
      camera.radius = startRadius + (3 - startRadius) * t;
      // Lerp target
      camera.setTarget(BABYLON.Vector3.Lerp(startTarget, target, t));
      if (t >= 1) {
        scene.onBeforeRenderObservable.removeCallback(lerpCamera);
      }
    }
    scene.onBeforeRenderObservable.add(lerpCamera);
  }
  trucString(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength - 3) + "...";
  }
}
const util = new Util();

//
// API Wrappers
//
class Net {
  //  https://nominatim.openstreetmap.org/search?q=Paris&format=json&limit=1
  cityToLatLong(city: string) {
    fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`)
      .then(response => response.json())
      .then(data => {
        if (data && data.length > 0) {
          const latitude = parseFloat(data[0].lat);
          const longitude = parseFloat(data[0].lon);
          console.log(`City ${city} Position - Latitude: ${latitude}, Longitude: ${longitude}`);
          state.userLatitude = latitude;
          state.userLongitude = longitude;
        } else {
          console.error("No results found for city:", city);
          console.log("We'll call this ocean")
        }
      })
      .catch(error => console.error("Error fetching city data:", error));
  }

  // https://nominatim.openstreetmap.org/reverse?lat=40.748817&lon=-73.985428&format=json
  latLongToLocation(latitude: number, longitude: number) {
    fetch(`https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`)
      .then(response => response.json())
      .then(data => {
        if (data && data.address) {
          console.log(`Location: ${data.display_name}`);
          state.locName = data.display_name;
        } else {
          console.error("No results found for coordinates:", latitude, longitude);
        }
      })
      .catch(error => console.error("Error fetching location data:", error));
  }

  updateISS() {
    // Make a request to https://api.wheretheiss.at/v1/satellites/25544
    fetch("https://api.wheretheiss.at/v1/satellites/25544")
      .then(response => response.json())
      .then(data => {
        const latitude = data.latitude;
        const longitude = data.longitude;
        console.log(`ISS Position - Latitude: ${latitude}, Longitude: ${longitude}`);
        state.issPosLast = state.issPos;
        state.issPos = { latitude, longitude };
        state.distance = Math.sqrt(Math.pow(latitude - state.userLatitude, 2) + Math.pow(longitude + state.userLongitude, 2));
        // Convert distance to km (1 degree is approximately 111 km)
        state.distance = state.distance * 111;
        if (state.distance < state.lastDistance) {
          state.direction = "towards";
        } else if (state.distance > state.lastDistance) {
          state.direction = "away";
        } else {
          state.direction = "???";
        }
        state.lastDistance = state.distance;
        state.dataRaw = data;
        net.latLongToLocation(latitude, longitude); // Update location name
      })
      .catch(error => console.error("Error fetching ISS data:", error));
  }
}
const net = new Net();

class Scene {
  camera(scene: BABYLON.Scene): { camera: BABYLON.ArcRotateCamera, scanline: BABYLON.PostProcess } {
    // Camera
    const initalZoom = 3;
    const camera = new BABYLON.ArcRotateCamera("camera", Math.PI / 2, Math.PI / 2.5, initalZoom, BABYLON.Vector3.Zero(), scene);
    // Lower the zoom speed
    camera.wheelDeltaPercentage = 0.01;
    camera.lowerRadiusLimit = 2; // minimum zoom distance
    camera.upperRadiusLimit = 10; // maximum zoom distance
    // camera.panningSensibility = 0;
    camera.panningDistanceLimit = 2;
    camera.attachControl(state.canvas, true);
    const scanline = new BABYLON.PostProcess(
      "scanline",
      "scanline",
      ["time"], // uniforms
      null,
      1.0,
      camera
    );
    return { camera, scanline };
  }

  light(scene: BABYLON.Scene): BABYLON.HemisphericLight {
    // Light
    const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(...state.mainColor), scene);
    light.intensity = 4;
    return light;
  }

  bgPlane(scene: BABYLON.Scene): { bgPlane: BABYLON.Mesh, gradientMaterial: BABYLON.ShaderMaterial } {
    const bgPlane = BABYLON.MeshBuilder.CreatePlane("bgPlane", { size: 40 }, scene);
    bgPlane.position.z = -2;
    const gradientMaterial = new BABYLON.ShaderMaterial(
      "gradientMaterial",
      scene,
      {
        vertex: "gradient",
        fragment: "gradient",
      },
      {
        attributes: ["position", "uv"],
        uniforms: ["worldViewProjection"],
      }
    );
    gradientMaterial.backFaceCulling = false;
    bgPlane.material = gradientMaterial;
    return { bgPlane, gradientMaterial };
  }

  earth(scene: BABYLON.Scene): BABYLON.Mesh {
    // Earth mesh
    const earth = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: 2, segments: 32 }, scene);
    const earthMaterial = new BABYLON.StandardMaterial("earthMaterial", scene);
    earthMaterial.diffuseTexture = new BABYLON.Texture("img/earth-hi-night-red.jpg", scene, false, false);
    (earthMaterial.diffuseTexture as BABYLON.Texture).uScale = -1; // Fix horizontal flip
    earthMaterial.bumpTexture = new BABYLON.Texture("img/earthbump1k.jpg", scene, false, false);
    (earthMaterial.bumpTexture as BABYLON.Texture).uScale = -1; // Fix horizontal flip
    earthMaterial.bumpTexture.level = 2; // Reduce bump intensity
    earthMaterial.emissiveColor = new BABYLON.Color3(...state.mainColor);
    earthMaterial.specularTexture = new BABYLON.Texture("img/8k_earth_specular_map.jpg", scene, false, false);
    (earthMaterial.specularTexture as BABYLON.Texture).uScale = -1; // Fix horizontal flip if needed
    earthMaterial.specularPower = 2; // Higher value = smaller, sharper highlights
    earthMaterial.specularColor = new BABYLON.Color3(...state.mainColor);
    earth.material = earthMaterial;
    return earth;
  }

  userMarker(scene: BABYLON.Scene): BABYLON.Mesh {
    const userMarkerDiameter = 0.05;
    const userMarker = BABYLON.MeshBuilder.CreateDisc("circle", { radius: userMarkerDiameter / 2, tessellation: 64 }, scene);
    const userMarkerMaterial = new BABYLON.StandardMaterial("circleMat", scene);
    userMarkerMaterial.diffuseColor = new BABYLON.Color3(...state.mainColor);
    userMarkerMaterial.emissiveColor = new BABYLON.Color3(...state.mainColor);
    userMarker.material = userMarkerMaterial;
    return userMarker;
  }

  poles(scene: BABYLON.Scene): BABYLON.Mesh {
    const poleHeight = 0.1;
    const poleDiameter = 0.05;

    // North Pole
    const northPole = BABYLON.MeshBuilder.CreateCylinder("northPole", {
      height: poleHeight,
      diameter: poleDiameter
    }, scene);
    const poleMaterial = new BABYLON.StandardMaterial("poleMat", scene);
    poleMaterial.diffuseColor = new BABYLON.Color3(...state.mainColor);
    poleMaterial.emissiveColor = new BABYLON.Color3(...state.mainColor);
    northPole.material = poleMaterial;
    northPole.position = new BABYLON.Vector3(0, 1 + poleHeight / 2, 0);

    // South Pole
    const southPole = BABYLON.MeshBuilder.CreateCylinder("southPole", {
      height: poleHeight,
      diameter: poleDiameter
    }, scene);
    southPole.material = poleMaterial;
    southPole.position = new BABYLON.Vector3(0, -1 - poleHeight / 2, 0);
    return northPole;
  }

  issMarker(scene: BABYLON.Scene, northPole: BABYLON.Mesh) {
    // Draw ISS marker
    state.issMarker = northPole.clone("otherCircle");
    // Change the color of the issMarker to blue
    const issMarkerMaterial = new BABYLON.StandardMaterial("issCircleMat", scene);
    issMarkerMaterial.diffuseColor = new BABYLON.Color3(...state.mainColor);
    issMarkerMaterial.emissiveColor = new BABYLON.Color3(...state.mainColor);
    state.issMarker.material = issMarkerMaterial;
  }

  title() {
    if (!state.engine) return;
    const advancedTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    state.titleBlock = new GUI.TextBlock();
    state.titleBlock.color = "cyan";
    state.titleBlock.fontSize = 24;
    state.titleBlock.fontFamily = "monospace";
    state.titleBlock.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    state.titleBlock.textVerticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
    state.titleBlock.paddingLeft = "22px";
    state.titleBlock.paddingTop = "30px";
    advancedTexture.addControl(state.titleBlock);
  }

  text() {
    if (!state.engine) return;
    state.textBlock = new GUI.TextBlock();
    const advancedTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    state.textBlock.color = "cyan";
    state.textBlock.fontFamily = "monospace";
    state.textBlock.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
    state.textBlock.textVerticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_BOTTOM;
    state.textBlock.paddingLeft = "22px";
    advancedTexture.addControl(state.textBlock);
  }

  overlay(): GUI.Rectangle {
    const overlayRect = new GUI.Rectangle();
    overlayRect.thickness = 4;    // Outline thickness
    overlayRect.color = "cyan";  // Outline color
    overlayRect.background = "";  // No fill
    const advancedTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
    advancedTexture.addControl(overlayRect);
    return overlayRect;
  }

  updateISSMarker() {
    if (state.issMarker) {
      const earthRadius = 1;
      const issAltitude = state.dataRaw ? state.dataRaw.altitude : 0; // in km
      const issRadius = earthRadius + (issAltitude / 6371);
      const pos = util.latLongToCartesian(state.issPos.latitude, state.issPos.longitude, issRadius);
      state.issMarker.position.set(pos.x, pos.y, pos.z);
      state.issMarker.position.set(pos.x, pos.y, pos.z);
      // Rotate the marker so that it faces the 0,0,0 point with a 90 degree local rotation on the X axis
      state.issMarker.lookAt(BABYLON.Vector3.Zero(), 0, Math.PI / 2);
      // Move the marker out a bit so it doesn't clip into the earth
      state.issMarker.position = state.issMarker.position.normalize().scale(1.2);
    }
  }

  updateText() {
    if (!state.engine || !state.textBlock) return;

    state.titleBlock.text = `ISS TRACKER ` + Date.now();

    state.textBlock.text = `
ISS|
ID#| ${state.dataRaw ? state.dataRaw.id : 'n/a'}
LTS| ${Math.floor(state.timeSinceUpdate / 1000)}s
LAT| ${state.issPos.latitude.toFixed(2)}
LON| ${state.issPos.longitude.toFixed(2)}
ALT| ${state.dataRaw ? state.dataRaw.altitude.toFixed(2) + " km" : 'n/a'}
VIS| ${state.dataRaw ? state.dataRaw.visibility.toUpperCase() : 'n/a'}
FTP| ${state.dataRaw ? state.dataRaw.footprint.toFixed(2) + " km" : 'n/a'}
SLT| ${state.dataRaw ? state.dataRaw.solar_lat.toFixed(2) : 'n/a'}
SLN| ${state.dataRaw ? state.dataRaw.solar_lon.toFixed(2) : 'n/a'}
OVR| ${util.trucString(state.locName.toUpperCase(), 16)}
DIS| ${state.distance.toFixed(2)} km
DIR| ${state.direction.toUpperCase()}
VEL| ${state.dataRaw ? state.dataRaw.velocity.toFixed(2) + " km/h" : 'n/a'}
GPL| MATHIEU DOMBROCK
`;
  }

  updateLight(light: BABYLON.HemisphericLight, camera: BABYLON.ArcRotateCamera) {
    light.direction = camera.position.normalize();
  }

  updateUserMarker(userMarker: BABYLON.Mesh, earth: BABYLON.Mesh) {
    const userPos = util.latLongToCartesian(state.userLatitude, state.userLongitude);
    userMarker.position = new BABYLON.Vector3(userPos.x, userPos.y, userPos.z);
    // Orient the circle to be tangent to the sphere
    userMarker.lookAt(earth.position.subtract(userMarker.position));
  }

  updateBgPane(bgPlane: BABYLON.Mesh, camera: BABYLON.ArcRotateCamera) {
    // Ensure the background pane is looking at the camera
    bgPlane.lookAt(camera.position);
    bgPlane.position = camera.position.scale(-2);
  }

  updateISSOrbit(scene: BABYLON.Scene) {
    // Draw the ISS orbit
    const earthRadius = 1; // scale your Earth mesh to radius 1
    const issAltitude = 420 / 6371; // scale altitude to mesh units
    const orbitRadius = earthRadius + issAltitude;
    const inclination = 51.6 * Math.PI / 180; // radians
    const points = [];
    const segments = 128;
    for (let i = 0; i <= segments; i++) {
      const theta = (i / segments) * 2 * Math.PI;
      // Circle in XZ plane, then rotate for inclination
      let x = orbitRadius * Math.cos(theta);
      let y = orbitRadius * Math.sin(theta) * Math.sin(inclination);
      let z = orbitRadius * Math.sin(theta) * Math.cos(inclination);
      points.push(new BABYLON.Vector3(x, y, z));
    }
    const orbitPath = BABYLON.MeshBuilder.CreateLines("issOrbit", { points: points }, scene);
    orbitPath.color = new BABYLON.Color3(...state.mainColor);
  }

  updateShaders(scanline: BABYLON.PostProcess, gradientMaterial: BABYLON.ShaderMaterial) {
    // Update shader
    // Update the time uniform every frame
    const time = performance.now() * 0.0001;
    scanline.onApply = (effect: BABYLON.Effect) => {
      effect.setFloat("time", time);
    };
    gradientMaterial.setFloat("time", time);
  }

  updateOverlay(overlayRect: GUI.Rectangle) {
    if (!state.engine) return;
    const viewportWidth = state.engine.getRenderWidth();
    const viewportHeight = state.engine.getRenderHeight();
    // Create the fullscreen GUI texture
    // Create the rectangle
    overlayRect.width = (viewportWidth - 20) + "px";
    overlayRect.height = (viewportHeight - 20) + "px";
  }

  updateCamera(camera: BABYLON.ArcRotateCamera, earth: BABYLON.Mesh) {
    // Slowly rotate the camera around the earth if not tracking
    if (!state.isTracking) {
      camera.alpha += 0.0001;
      // camera.setTarget(earth.position); // Always target the earth
    }
  }

  createScene(): BABYLON.Scene {
    if (!state.engine || !state.canvas) {
      throw new Error("Engine or canvas not initialized");
    }
    const scene = new BABYLON.Scene(state.engine);
    // Set the clear color to black
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

    let { camera, scanline } = this.camera(scene);
    let { bgPlane, gradientMaterial } = this.bgPlane(scene);
    let light = this.light(scene);
    let earth = this.earth(scene);
    let userMarker = this.userMarker(scene);
    const northPole = this.poles(scene);
    this.issMarker(scene, northPole);
    this.title();
    this.text();
    const overlayRect = this.overlay();

    // Update loop
    scene.registerBeforeRender(() => {
      this.updateISSMarker();
      this.updateText();
      this.updateLight(light, camera);
      this.updateUserMarker(userMarker, earth);
      this.updateBgPane(bgPlane, camera);
      // this.updateISSOrbit(scene);
      this.updateShaders(scanline, gradientMaterial);
      this.updateOverlay(overlayRect);
      this.updateCamera(camera, earth);
    });

    return scene;
  }

  startScene(): void {
    const el = document.getElementById("renderCanvas");
    if (el instanceof HTMLCanvasElement) {
      state.canvas = el;
    } else {
      throw new Error('"renderCanvas" is not a canvas element');
    }
    state.engine = new BABYLON.Engine(state.canvas, true, { preserveDrawingBuffer: true, stencil: true });

    if (!state.engine) {
      console.error("Babylon engine creation failed");
      return;
    }

    // Check if there is a city parameter in the URL
    // This will override the geolocation API
    const urlParams = new URLSearchParams(window.location.search);
    const city = urlParams.get('city');
    if (city) {
      net.cityToLatLong(city);
    }
    else {
      util.requestUserLocation();
    }

    // Start ISS location updates
    net.updateISS();
    setInterval(() => net.updateISS(), 5000);

    // Start timestamp updates
    setInterval(() => {
      if (state.dataRaw) {
        state.timeSinceUpdate = Date.now() - state.dataRaw.timestamp * 1000;
      }
    }, 500);

    // Init the Babylon scene and engine
    const scene = this.createScene();
    state.engine.runRenderLoop(function() {
      scene.render();
    });

    // Listen for space key to focus and rotate camera on ISS
    window.addEventListener("keydown", function(event) {
      if (event.code === "Space") {
        util.focusOnISS();
        event.preventDefault();
      }
    });

    // Handle browser resize events
    window.addEventListener("resize", function() {
      if (state.engine === null) return;
      state.engine.resize();
    });
  }
}
const scene = new Scene();

scene.startScene();
