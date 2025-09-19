const canvas = document.getElementById("renderCanvas");

const engine = new BABYLON.Engine(canvas, true);

let userLatitude = 47.608013; // Example: Seattle
let userLongitude = -122.335167;
let issPos = { latitude: 99, longitude: 99 };
let distance = 0;
let lastDistance = 0;
let direction = "???";
let timeSinceUpdate = 0;
let dataRaw = null;
let issMarker = null;
let textBlock = null;

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
//   https://nominatim.openstreetmap.org/search?q=Paris&format=json&limit=1
function cityToLatLong(city) {
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

function latLongToCartesian(latitude, longitude) {
  const r = 1; // earth radius
  const latRad = latitude * Math.PI / 180;
  const lonRad = (longitude + 180) * Math.PI / 180;
  const x = r * Math.cos(latRad) * Math.cos(lonRad);
  const y = r * Math.sin(latRad);
  const z = r * Math.cos(latRad) * Math.sin(lonRad);
  return { x, y, z };
}

const createScene = function() {
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
  earthMaterial.diffuseTexture.uScale = -1; // Fix horizontal flip
  earthMaterial.bumpTexture = new BABYLON.Texture("public/earthbump1k.jpg", scene, false, false);
  earthMaterial.bumpTexture.uScale = -1; // Fix horizontal flip
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
  const poleHeight = 0.5;
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
  const advancedTexture = BABYLON.GUI.AdvancedDynamicTexture.CreateFullscreenUI("UI");
  textBlock = new BABYLON.GUI.TextBlock();
  textBlock.color = "white";
  textBlock.fontSize = 24;
  textBlock.fontFamily = "monospace";
  textBlock.textHorizontalAlignment = BABYLON.GUI.Control.HORIZONTAL_ALIGNMENT_LEFT;
  textBlock.textVerticalAlignment = BABYLON.GUI.Control.VERTICAL_ALIGNMENT_TOP;
  textBlock.paddingLeft = (viewportWidth * 0.6) + "px";
  textBlock.paddingTop = (viewportHeight * 0.6) + "px";
  advancedTexture.addControl(textBlock);

  scene.registerBeforeRender(() => {
    if (issMarker) {
      const pos = latLongToCartesian(issPos.latitude, issPos.longitude);
      issMarker.position.set(pos.x, pos.y, pos.z);
      // Rotate the marker so that it faces the 0,0,0 point with a 90 degree local rotation on the X axis
      issMarker.lookAt(BABYLON.Vector3.Zero(), 0, Math.PI / 2);
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

const scene = createScene();

engine.runRenderLoop(function() {
  scene.render();
});

window.addEventListener("resize", function() {
  engine.resize();
});
