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
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
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
app.get("/", (req, res) => {
  res.redirect("/setup");
});

app.get("/setup", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup.html"));
});

app.get("/location", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "location.html"));
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

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});