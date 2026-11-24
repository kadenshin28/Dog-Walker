const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = 3000;

// Where uploaded pictures and saved data live
const uploadsDir = path.join(__dirname, "uploads");
const dataFile = path.join(__dirname, "dogs.json");
const locationFile = path.join(__dirname, "location.json");

if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, "[]");
if (!fs.existsSync(locationFile)) fs.writeFileSync(locationFile, "{}");

// Helpers to read/write the dogs file
function readDogs() {
  return JSON.parse(fs.readFileSync(dataFile, "utf8"));
}
function saveDogs(dogs) {
  fs.writeFileSync(dataFile, JSON.stringify(dogs, null, 2));
}

// Helpers for the saved location
function readLocation() {
  return JSON.parse(fs.readFileSync(locationFile, "utf8"));
}
function saveLocation(location) {
  fs.writeFileSync(locationFile, JSON.stringify(location, null, 2));
}
// Helpers for saved walks (safe if the file is empty or broken)
function readWalks() {
  try {
    const text = fs.readFileSync(walksFile, "utf8").trim();
    return text ? JSON.parse(text) : [];
  } catch (err) {
    return [];
  }
}
function saveWalks(walks) {
  fs.writeFileSync(walksFile, JSON.stringify(walks, null, 2));
}
// Distance between two GPS points in meters 
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
// multer: save uploaded pictures to /uploads with a unique name
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, Date.now() + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith("image/")); // images only
  },
});

// Lets the server read JSON sent by fetch()
app.use(express.json());

// Serve the public folder and uploaded pictures
app.use(express.static("public"));
app.use("/uploads", express.static(uploadsDir));

// Pages

app.get("/profile", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "profile.html"));
});

app.get("/", (req, res) => {
  const dogs = readDogs();

  if (dogs.length > 0) {
    res.redirect("/homepage");   // returning user
  } else {
    res.redirect("/setup");      // first time, no dogs yet
  }
});

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/location", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "location.html"));
});

app.get("/homepage", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "homepage.html"));
});

// API: list all dogs
app.get("/api/dogs", (req, res) => {
  res.json(readDogs());
});

// API: add a dog (form data with an optional picture)
app.post("/api/dogs", upload.single("picture"), (req, res) => {
  const name = (req.body.dogName || "").trim();
  const breed = (req.body.breed || "").trim();

  if (!name || !breed) {
    return res.status(400).json({ error: "Name and breed are required." });
  }

  const dog = {
    id: Date.now(),
    name,
    breed,
    picture: req.file ? "/uploads/" + req.file.filename : null,
  };

  const dogs = readDogs();
  dogs.push(dog);
  saveDogs(dogs);

  res.status(201).json(dog);
});

// API: get the saved location
app.get("/api/location", (req, res) => {
  res.json(readLocation());
});

// API: save the zip code
app.post("/api/location", (req, res) => {
  const zip = String(req.body.zip || "").trim();

  // Exactly 5 digits (US ZIP code)
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: "Please enter a valid 5-digit ZIP code." });
  }

  const location = { zip };
  saveLocation(location);
  res.json(location);
});
// API: current weather + daylight status for the saved ZIP code
app.get("/api/weather", async (req, res) => {
  const { zip } = readLocation();
  if (!zip) {
    return res.status(400).json({ error: "No ZIP code saved yet." });
  }

  try {
    // 1. ZIP code -> city + coordinates
    const zipResponse = await fetch(`https://api.zippopotam.us/us/${zip}`);
    if (!zipResponse.ok) {
      return res.status(404).json({ error: "ZIP code not found." });
    }
    const zipData = await zipResponse.json();
    const place = zipData.places[0];

    // 2. Coordinates -> current weather + today's sunrise/sunset
    const weatherUrl =
      "https://api.open-meteo.com/v1/forecast" +
      `?latitude=${place.latitude}&longitude=${place.longitude}` +
      "&current=temperature_2m,weather_code,wind_speed_10m" +
      "&daily=sunrise,sunset" +
      "&timezone=auto" +
      "&temperature_unit=fahrenheit&wind_speed_unit=mph";

    const weatherResponse = await fetch(weatherUrl);
    if (!weatherResponse.ok) {
      throw new Error("Weather service error");
    }
    const weather = await weatherResponse.json();

    // 3. Work out the daylight status
    const now = Date.parse(weather.current.time + "Z");
    const sunrise = Date.parse(weather.daily.sunrise[0] + "Z");
    const sunset = Date.parse(weather.daily.sunset[0] + "Z");
    const HOUR = 60 * 60 * 1000;

    let daylight;
    if (now < sunrise) {
      daylight = sunrise - now <= HOUR ? "getting_bright" : "dark";
    } else if (now >= sunset) {
      daylight = "dark";
    } else {
      daylight = sunset - now <= HOUR ? "getting_dark" : "day";
    }

    res.json({
      city: place["place name"],
      state: place["state abbreviation"],
      temperature: Math.round(weather.current.temperature_2m),
      windSpeed: Math.round(weather.current.wind_speed_10m),
      code: weather.current.weather_code,
      daylight,
    });
  } catch (err) {
    console.error("Weather error:", err);
    res.status(502).json({ error: "Could not get the weather." });
  }
});
const walksFile = path.join(__dirname, "walks.json");
if (!fs.existsSync(walksFile)) fs.writeFileSync(walksFile, "[]");
// API: list the saved walks for one dog
app.get("/api/dogs/:id/walks", (req, res) => {
  const walks = readWalks().filter((w) => String(w.dogId) === req.params.id);
  res.json(walks);
});

// API: save a finished walk for one dog
// Save a finished walk for one dog
app.post("/api/dogs/:id/walks", (req, res) => {
  const dog = readDogs().find((d) => String(d.id) === req.params.id);
  if (!dog) {
    return res.status(404).json({ error: "Dog not found." });
  }

  const seconds = Number(req.body.seconds);
  const startedAt = Number(req.body.startedAt);

  // Must be a real number between 1 second and 24 hours
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 24 * 60 * 60) {
    return res.status(400).json({ error: "That walk length doesn't look right." });
  }
  if (!Number.isFinite(startedAt)) {
    return res.status(400).json({ error: "Missing the walk's start time." });
  }

  // Distance is optional (0 if GPS wasn't available), max about 124 miles
  let meters = 0;
  if (req.body.meters !== undefined) {
    meters = Number(req.body.meters);
    if (!Number.isFinite(meters) || meters < 0 || meters > 200000) {
      return res.status(400).json({ error: "That distance doesn't look right." });
    }
  }

  const walk = {
    id: Date.now(),
    dogId: dog.id,
    startedAt,
    seconds: Math.round(seconds),
    meters: Math.round(meters),
  };

  const walks = readWalks();
  walks.push(walk);
  saveWalks(walks);

  res.status(201).json(walk);
});
// API: total walking stats for each dog
app.get("/api/stats", (req, res) => {
  const dogs = readDogs();
  const walks = readWalks();

  const stats = dogs.map((dog) => {
    const mine = walks.filter((w) => String(w.dogId) === String(dog.id));

    return {
      dogId: dog.id,
      name: dog.name,
      walks: mine.length,
      seconds: mine.reduce((sum, w) => sum + (w.seconds || 0), 0),
      meters: mine.reduce((sum, w) => sum + (w.meters || 0), 0),
    };
  });

  res.json(stats);
});
// API: dog parks near the saved ZIP code (data from OpenStreetMap, no key needed)
// ---------- Communities (read from communities.json) ----------
// ---------- Communities ----------
const communitiesFile = path.join(__dirname, "communities.json");
const MAX_MILES = 25;

// Safe read of your own list (used if the live lookup fails)
function readCommunities() {
  try {
    const text = fs.readFileSync(communitiesFile, "utf8").trim();
    return text ? JSON.parse(text) : [];
  } catch (err) {
    console.error("Could not read communities.json:", err.message);
    return [];
  }
}

// ZIP code -> coordinates, remembered so we only look each ZIP up once
const zipCoordsCache = new Map();

async function getZipCoords(zip) {
  if (zipCoordsCache.has(zip)) return zipCoordsCache.get(zip);

  try {
    const response = await fetch(`https://api.zippopotam.us/us/${zip}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return null;

    const place = (await response.json()).places[0];
    const coords = { lat: Number(place.latitude), lon: Number(place.longitude) };
    zipCoordsCache.set(zip, coords);
    return coords;
  } catch (err) {
    console.error("ZIP lookup failed:", (err.cause && err.cause.code) || err.message);
    return null;
  }
}

// Dog parks from OpenStreetMap (free, no key). Results are remembered for 6 hours.
const osmCache = new Map();
const OSM_CACHE_MS = 6 * 60 * 60 * 1000;

async function findOsmDogParks(zip, lat, lon) {
  const cached = osmCache.get(zip);
  if (cached && Date.now() - cached.time < OSM_CACHE_MS) return cached.places;

  // Dog parks within 10 km (about 6 miles)
  const query =
    "[out:json][timeout:25];(" +
    `node["leisure"="dog_park"](around:10000,${lat},${lon});` +
    `way["leisure"="dog_park"](around:10000,${lat},${lon});` +
    ");out center 40;";

  // Try the main server first, then a backup
  const servers = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  let data = null;
  for (const url of servers) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
          "User-Agent": "DogWalkerApp/1.0 (student project)",
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(20000),
      });
      if (response.ok) {
        data = await response.json();
        break;
      }
      console.error("Places server", url, "answered with status", response.status);
    } catch (err) {
      console.error("Places server", url, "failed:", (err.cause && err.cause.code) || err.message);
    }
  }

  if (!data) return null;

  const places = data.elements
    .map((el) => {
      const pLat = el.lat ?? (el.center && el.center.lat);
      const pLon = el.lon ?? (el.center && el.center.lon);
      if (pLat === undefined || pLon === undefined) return null;

      return {
        name: (el.tags && el.tags.name) || "Dog park",
        type: "Dog park",
        description: "",
        link: `https://www.google.com/maps/search/?api=1&query=${pLat},${pLon}`,
        meters: Math.round(distanceMeters(lat, lon, pLat, pLon)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 8);

  osmCache.set(zip, { time: Date.now(), places });
  return places;
}

// Your own list: add distances, filter, sort, keep 8
function listFromFile(zip, here) {
  return readCommunities()
    .map((c) => {
      let meters = null;
      if (here && typeof c.lat === "number" && typeof c.lon === "number") {
        meters = Math.round(distanceMeters(here.lat, here.lon, c.lat, c.lon));
      }
      return { c, meters };
    })
    .filter(({ c, meters }) => {
      if (meters !== null) return meters <= MAX_MILES * 1609.344;
      return zip.startsWith(String(c.zipPrefix || ""));
    })
    .sort((a, b) => {
      if (a.meters !== null && b.meters !== null) return a.meters - b.meters;
      if (a.meters !== null) return -1;
      if (b.meters !== null) return 1;
      return String(b.c.zipPrefix || "").length - String(a.c.zipPrefix || "").length;
    })
    .slice(0, 8)
    .map(({ c, meters }) => ({
      name: String(c.name || "Unnamed"),
      type: String(c.type || ""),
      description: String(c.description || ""),
      link: /^https?:\/\//i.test(c.link || "") ? c.link : "",
      meters,
    }));
}

// API: communities near the saved ZIP code
app.get("/api/communities", async (req, res) => {
  const { zip } = readLocation();
  if (!zip) {
    return res.status(400).json({ error: "Save a ZIP code to see communities near you." });
  }

  const here = await getZipCoords(zip); // null if the lookup fails

  // 1. Live dog parks from OpenStreetMap
  if (here) {
    try {
      const live = await findOsmDogParks(zip, here.lat, here.lon);
      if (live && live.length > 0) {
        return res.json({ zip, source: "osm", places: live });
      }
    } catch (err) {
      console.error("Live parks failed:", err.message);
    }
  }

  // 2. Otherwise, your own list
  res.json({ zip, source: "file", places: listFromFile(zip, here) });
});
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
