// api.js: a tiny "server" that runs inside the browser, for GitHub Pages.
// Your pages already call fetch("/api/..."). This file answers those calls
// from the browser's own storage instead of from a Node server.
(function () {
  const realFetch = window.fetch.bind(window);

  // ---------- Saving and loading ----------
  function load(key, fallback) {
    try {
      const text = localStorage.getItem("dogwalker:" + key);
      return text ? JSON.parse(text) : fallback;
    } catch (err) {
      return fallback;
    }
  }

  function save(key, value) {
    localStorage.setItem("dogwalker:" + key, JSON.stringify(value));
  }

  function reply(data, status) {
    return new Response(JSON.stringify(data), {
      status: status || 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // ---------- Distance between two GPS points, in meters ----------
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

  // ---------- Photos: shrink to fit in browser storage ----------
  function shrinkPhoto(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        const scale = Math.min(1, 400 / Math.max(img.width, img.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null); // the browser couldn't read it: save the dog without a photo
      };

      img.src = url;
    });
  }

  // ---------- ZIP code -> coordinates and city ----------
  const zipCache = new Map();

  async function zipInfo(zip) {
    if (zipCache.has(zip)) return zipCache.get(zip);
    try {
      const response = await realFetch("https://api.zippopotam.us/us/" + zip, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) return null;

      const place = (await response.json()).places[0];
      const info = {
        lat: Number(place.latitude),
        lon: Number(place.longitude),
        city: place["place name"],
        state: place["state abbreviation"],
      };
      zipCache.set(zip, info);
      return info;
    } catch (err) {
      return null;
    }
  }

  // ---------- Weather ----------
  async function weather() {
    const zip = load("location", {}).zip;
    if (!zip) return reply({ error: "No ZIP code saved yet." }, 400);

    const here = await zipInfo(zip);
    if (!here) return reply({ error: "ZIP code not found." }, 404);

    try {
      const url =
        "https://api.open-meteo.com/v1/forecast" +
        "?latitude=" + here.lat + "&longitude=" + here.lon +
        "&current=temperature_2m,weather_code,wind_speed_10m" +
        "&daily=sunrise,sunset&timezone=auto" +
        "&temperature_unit=fahrenheit&wind_speed_unit=mph";

      const response = await realFetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Weather service error");
      const w = await response.json();

      // Daylight status: compare now to today's sunrise and sunset
      const now = Date.parse(w.current.time + "Z");
      const sunrise = Date.parse(w.daily.sunrise[0] + "Z");
      const sunset = Date.parse(w.daily.sunset[0] + "Z");
      const HOUR = 60 * 60 * 1000;

      let daylight;
      if (now < sunrise) {
        daylight = sunrise - now <= HOUR ? "getting_bright" : "dark";
      } else if (now >= sunset) {
        daylight = "dark";
      } else {
        daylight = sunset - now <= HOUR ? "getting_dark" : "day";
      }

      return reply({
        city: here.city,
        state: here.state,
        temperature: Math.round(w.current.temperature_2m),
        windSpeed: Math.round(w.current.wind_speed_10m),
        code: w.current.weather_code,
        daylight,
      });
    } catch (err) {
      return reply({ error: "Could not get the weather." }, 502);
    }
  }

  // ---------- Communities ----------
  const MAX_MILES = 25;

  // Live dog parks from OpenStreetMap (remembered for this browser tab)
  async function osmDogParks(zip, here) {
    const cacheKey = "dogwalker:osm:" + zip;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {}

    const query =
      "[out:json][timeout:25];(" +
      'node["leisure"="dog_park"](around:10000,' + here.lat + "," + here.lon + ");" +
      'way["leisure"="dog_park"](around:10000,' + here.lat + "," + here.lon + ");" +
      ");out center 40;";

    const servers = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ];

    for (const url of servers) {
      try {
        const response = await realFetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) continue;

        const data = await response.json();
        const places = data.elements
          .map((el) => {
            const pLat = el.lat ?? (el.center && el.center.lat);
            const pLon = el.lon ?? (el.center && el.center.lon);
            if (pLat === undefined || pLon === undefined) return null;
            return {
              name: (el.tags && el.tags.name) || "Dog park",
              type: "Dog park",
              description: "",
              link: "https://www.google.com/maps/search/?api=1&query=" + pLat + "," + pLon,
              meters: Math.round(distanceMeters(here.lat, here.lon, pLat, pLon)),
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.meters - b.meters)
          .slice(0, 8);

        try { sessionStorage.setItem(cacheKey, JSON.stringify(places)); } catch (err) {}
        return places;
      } catch (err) {
        // try the next server
      }
    }
    return null;
  }

  async function communities() {
    const zip = load("location", {}).zip;
    if (!zip) {
      return reply({ error: "Save a ZIP code to see communities near you." }, 400);
    }

    const here = await zipInfo(zip);

    // 1. Live results, if they work
    if (here) {
      const live = await osmDogParks(zip, here);
      if (live && live.length > 0) {
        return reply({ zip, source: "osm", places: live });
      }
    }

    // 2. Otherwise your own list (communities.json, next to the pages)
    let list = [];
    try {
      const response = await realFetch("communities.json");
      if (response.ok) list = await response.json();
    } catch (err) {}

    const places = list
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

    return reply({ zip, source: "file", places });
  }

  // ---------- The request handler ----------
  async function handle(method, path, body) {
    // Dogs
    if (path === "/api/dogs" && method === "GET") {
      return reply(load("dogs", []));
    }

    if (path === "/api/dogs" && method === "POST") {
      const name = String(body.get("dogName") || "").trim();
      const breed = String(body.get("breed") || "").trim();
      if (!name || !breed) {
        return reply({ error: "Name and breed are required." }, 400);
      }

      const file = body.get("picture");
      const hasPhoto = file && file.size > 0 && file.type.startsWith("image/");
      const picture = hasPhoto ? await shrinkPhoto(file) : null;

      const dog = { id: Date.now(), name, breed, picture };
      const dogs = load("dogs", []);
      dogs.push(dog);
      save("dogs", dogs);
      return reply(dog, 201);
    }

    // Location
    if (path === "/api/location" && method === "GET") {
      return reply(load("location", {}));
    }

    if (path === "/api/location" && method === "POST") {
      const zip = String((body && body.zip) || "").trim();
      if (!/^\d{5}$/.test(zip)) {
        return reply({ error: "Please enter a valid 5-digit ZIP code." }, 400);
      }
      save("location", { zip });
      return reply({ zip });
    }

    // Walks for one dog
    const walksMatch = path.match(/^\/api\/dogs\/([^/]+)\/walks$/);
    if (walksMatch) {
      const dogId = decodeURIComponent(walksMatch[1]);

      if (method === "GET") {
        return reply(load("walks", []).filter((w) => String(w.dogId) === dogId));
      }

      if (method === "POST") {
        const dog = load("dogs", []).find((d) => String(d.id) === dogId);
        if (!dog) return reply({ error: "Dog not found." }, 404);

        const seconds = Number(body.seconds);
        const startedAt = Number(body.startedAt);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 24 * 60 * 60) {
          return reply({ error: "That walk length doesn't look right." }, 400);
        }
        if (!Number.isFinite(startedAt)) {
          return reply({ error: "Missing the walk's start time." }, 400);
        }

        let meters = 0;
        if (body.meters !== undefined) {
          meters = Number(body.meters);
          if (!Number.isFinite(meters) || meters < 0 || meters > 200000) {
            return reply({ error: "That distance doesn't look right." }, 400);
          }
        }

        const walk = {
          id: Date.now(),
          dogId: dog.id,
          startedAt,
          seconds: Math.round(seconds),
          meters: Math.round(meters),
        };
        const walks = load("walks", []);
        walks.push(walk);
        save("walks", walks);
        return reply(walk, 201);
      }
    }

    // Stats for every dog
    if (path === "/api/stats" && method === "GET") {
      const walks = load("walks", []);
      const stats = load("dogs", []).map((dog) => {
        const mine = walks.filter((w) => String(w.dogId) === String(dog.id));
        return {
          dogId: dog.id,
          name: dog.name,
          walks: mine.length,
          seconds: mine.reduce((sum, w) => sum + (w.seconds || 0), 0),
          meters: mine.reduce((sum, w) => sum + (w.meters || 0), 0),
        };
      });
      return reply(stats);
    }

    if (path === "/api/weather" && method === "GET") return weather();
    if (path === "/api/communities" && method === "GET") return communities();

    return reply({ error: "Not found." }, 404);
  }

  // ---------- Catch the page's fetch("/api/...") calls ----------
  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);

    const method = ((init && init.method) || "GET").toUpperCase();
    let body = init && init.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch (err) {}
    }

    try {
      return await handle(method, url.split("?")[0], body);
    } catch (err) {
      console.error("api.js error:", err);
      return reply({ error: "Something went wrong (browser storage may be full)." }, 500);
    }
  };
})();
