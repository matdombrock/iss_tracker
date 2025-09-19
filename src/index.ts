import * as BABYLON from "@babylonjs/core";
import * as GUI from "@babylonjs/gui";
import "@babylonjs/loaders";

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('Canvas element not found');
}
const engine = new BABYLON.Engine(canvas, true);

let userLatitude = 47.608013; // Example: Seattle
let userLongitude = -122.335167;
let issPos = { latitude: 99, longitude: 99 };
let issPosLast = { latitude: 99, longitude: 99 };
let distance = 0;
let lastDistance = 0;
let direction = "???";
let timeSinceUpdate = 0;
let dataRaw: any = null;
let issMarker: any = null;
let textBlock: any = null;

//   https://nominatim.openstreetmap.org/search?q=Paris&format=json&limit=1
function cityToLatLong(city: string) {
  fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`)
    .then(response => response.json())
    .then(data => {
      if (data && data.length > 0) {
        const latitude = parseFloat(data[0].lat);
        const longitude = parseFloat(data[0].lon);
        console.log(`City ${city} Position - Latitude: ${latitude}, Longitude: ${longitude}`);
        userLatitude = latitude;
        userLongitude = longitude;
      } else {
        console.error("No results found for city:", city);
      }
    })
    .catch(error => console.error("Error fetching city data:", error));
}

function latLongToCartesian(latitude: number, longitude: number) {
  const r = 1; // earth radius
  const latRad = latitude * Math.PI / 180;
  const lonRad = (longitude + 180) * Math.PI / 180;
  const x = r * Math.cos(latRad) * Math.cos(lonRad);
  const y = r * Math.sin(latRad);
  const z = r * Math.cos(latRad) * Math.sin(lonRad);
  return { x, y, z };
}

function createScene(): BABYLON.Scene {
  const scene = new BABYLON.Scene(engine);
  // Set the clear color to black
  scene.clearColor = new BABYLON.Color4(0, 0, 0, 1);

  // Camera
  const camera = new BABYLON.ArcRotateCamera("camera", Math.PI / 2, Math.PI / 2.5, 6, BABYLON.Vector3.Zero(), scene);
  // Lower the zoom speed
  camera.wheelDeltaPercentage = 0.01;
  camera.attachControl(canvas, true);

  // Light
  const light = new BABYLON.HemisphericLight("light", new BABYLON.Vector3(1, 1, 0), scene);
  light.intensity = 4;

  // Earth mesh
  const earth = BABYLON.MeshBuilder.CreateSphere("earth", { diameter: 2, segments: 32 }, scene);
  const earthMaterial = new BABYLON.StandardMaterial("earthMaterial", scene);
  earthMaterial.diffuseTexture = new BABYLON.Texture("public/earth-bw.jpg", scene, false, false);
  (earthMaterial.diffuseTexture as BABYLON.Texture).uScale = -1; // Fix horizontal flip
  earthMaterial.bumpTexture = new BABYLON.Texture("public/earthbump1k.jpg", scene, false, false);
  (earthMaterial.bumpTexture as BABYLON.Texture).uScale = -1; // Fix horizontal flip
  earthMaterial.bumpTexture.level = 2; // Reduce bump intensity
  earthMaterial.emissiveColor = new BABYLON.Color3(1, 0, 0);
  earth.material = earthMaterial;

  // Draw a red circle on the surface of the earth
  const userMarkerDiameter = 0.05;
  const userMarker = BABYLON.MeshBuilder.CreateDisc("circle", { radius: userMarkerDiameter / 2, tessellation: 64 }, scene);
  const userMarkerMaterial = new BABYLON.StandardMaterial("circleMat", scene);
  userMarkerMaterial.diffuseColor = new BABYLON.Color3(1, 0, 0);
  userMarkerMaterial.emissiveColor = new BABYLON.Color3(1, 0, 0);
  userMarker.material = userMarkerMaterial;

  // Draw red poles coming out of the earth model
  const poleHeight = 0.25;
  const poleDiameter = 0.05;

  // North Pole
  const northPole = BABYLON.MeshBuilder.CreateCylinder("northPole", {
    height: poleHeight,
    diameter: poleDiameter
  }, scene);
  const poleMaterial = new BABYLON.StandardMaterial("poleMat", scene);
  poleMaterial.diffuseColor = new BABYLON.Color3(1, 0, 0);
  poleMaterial.emissiveColor = new BABYLON.Color3(1, 0, 0);
  northPole.material = poleMaterial;
  northPole.position = new BABYLON.Vector3(0, 1 + poleHeight / 2, 0);

  // South Pole
  const southPole = BABYLON.MeshBuilder.CreateCylinder("southPole", {
    height: poleHeight,
    diameter: poleDiameter
  }, scene);
  southPole.material = poleMaterial;
  southPole.position = new BABYLON.Vector3(0, -1 - poleHeight / 2, 0);

  // Draw ISS marker
  issMarker = northPole.clone("otherCircle");
  // Change the color of the issMarker to blue
  const issMarkerMaterial = new BABYLON.StandardMaterial("issCircleMat", scene);
  issMarkerMaterial.diffuseColor = new BABYLON.Color3(1, 0, 0);
  issMarkerMaterial.emissiveColor = new BABYLON.Color3(1, 0, 0);
  issMarker.material = issMarkerMaterial;

  const viewportWidth = engine.getRenderWidth();
  const viewportHeight = engine.getRenderHeight();
  // Draw the ISS position to the screen as text
  const advancedTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
  textBlock = new GUI.TextBlock();
  textBlock.color = "white";
  textBlock.fontSize = 24;
  textBlock.fontFamily = "monospace";
  textBlock.textHorizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
  textBlock.textVerticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
  textBlock.paddingLeft = (viewportWidth * 0.6) + "px";
  textBlock.paddingTop = (viewportHeight * 0.6) + "px";
  advancedTexture.addControl(textBlock);

  scene.registerBeforeRender(() => {
    if (issMarker) {
      const pos = latLongToCartesian(issPos.latitude, issPos.longitude);
      issMarker.position.set(pos.x, pos.y, pos.z);
      // Rotate the marker so that it faces the 0,0,0 point with a 90 degree local rotation on the X axis
      issMarker.lookAt(BABYLON.Vector3.Zero(), 0, Math.PI / 2);
      // Move the marker out a bit so it doesn't clip into the earth
      issMarker.position = issMarker.position.normalize().scale(1.2);
    }
    textBlock.text = `
ISS|
LTS| ${Math.floor(timeSinceUpdate / 1000)}s
LAT| ${issPos.latitude.toFixed(2)}
LON| ${issPos.longitude.toFixed(2)}
DIS| ${distance.toFixed(2)} km
DIR| ${direction.toUpperCase()}
VEL| ${dataRaw ? dataRaw.velocity.toFixed(2) + " km/h" : 'n/a'}
`;
    light.direction = camera.position.normalize();
    const userPos = latLongToCartesian(userLatitude, userLongitude);
    userMarker.position = new BABYLON.Vector3(userPos.x, userPos.y, userPos.z);
    // Orient the circle to be tangent to the sphere
    userMarker.lookAt(earth.position.subtract(userMarker.position));

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
    orbitPath.color = new BABYLON.Color3(1, 0, 0);
  });

  return scene;
};

function updateISS() {
  // Make a request to https://api.wheretheiss.at/v1/satellites/25544
  fetch("https://api.wheretheiss.at/v1/satellites/25544")
    .then(response => response.json())
    .then(data => {
      const latitude = data.latitude;
      const longitude = data.longitude;
      console.log(`ISS Position - Latitude: ${latitude}, Longitude: ${longitude}`);
      issPosLast = issPos;
      issPos = { latitude, longitude };
      distance = Math.sqrt(Math.pow(latitude - userLatitude, 2) + Math.pow(longitude + userLongitude, 2));
      // Convert distance to km (1 degree is approximately 111 km)
      distance = distance * 111;
      if (distance < lastDistance) {
        direction = "away";
      } else if (distance > lastDistance) {
        direction = "towards";
      } else {
        direction = "???";
      }
      lastDistance = distance;
      dataRaw = data;
    })
    .catch(error => console.error("Error fetching ISS data:", error));
}

function init(): void {
  updateISS();
  setInterval(updateISS, 5000);

  setInterval(() => {
    timeSinceUpdate = Date.now() - dataRaw.timestamp * 1000;
  }, 500);

  // Check if there is a city parameter in the URL
  const urlParams = new URLSearchParams(window.location.search);
  const city = urlParams.get('city');
  if (city) {
    cityToLatLong(city);
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      console.log("User position obtained:");
      console.log(position.coords.latitude, position.coords.longitude);
      userLatitude = position.coords.latitude;
      userLongitude = position.coords.longitude;
    },
    (error) => {
      console.error(error);
    }
  )

  const scene = createScene();

  engine.runRenderLoop(function() {
    scene.render();
  });

  window.addEventListener("resize", function() {
    engine.resize();
  });
}
init();
