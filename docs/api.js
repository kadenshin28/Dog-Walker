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

  // ---------- Distance between two GPS points ----------
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = (deg) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------- Photos ----------
  function shrinkPhoto(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        const scale = Math.min(
          1,
          400 / Math.max(img.width, img.height)
        );

        const canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);

        canvas.getContext("2d").drawImage(
          img,
          0,
          0,
          canvas.width,
          canvas.height
        );

        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.8));
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve(null);
      };

      img.src = url;
    });
  }

  // ---------- ZIP code -> coordinates and city ----------
  const zipCache = new Map();

  async function zipInfo(zip) {
    if (zipCache.has(zip)) {
      return zipCache.get(zip);
    }

    try {
      const response = await realFetch(
        "https://api.zippopotam.us/us/" + encodeURIComponent(zip),
        {
          signal: AbortSignal.timeout(8000),
        }
      );

      if (!response.ok) return null;

      const data = await response.json();
      if (!data.places || !data.places.length) return null;

      const place = data.places[0];

      const info = {
        lat: Number(place.latitude),
        lon: Number(place.longitude),
        city: place["place name"],
        state: place["state abbreviation"],
      };

      zipCache.set(zip, info);
      return info;
    } catch (err) {
      console.error("ZIP lookup failed:", err);
      return null;
    }
  }

  // ---------- Weather ----------
  async function weather() {
    const zip = load("location", {}).zip;

    if (!zip) {
      return reply({ error: "No ZIP code saved yet." }, 400);
    }

    const here = await zipInfo(zip);

    if (!here) {
      return reply({ error: "ZIP code not found." }, 404);
    }

    try {
      const url =
        "https://api.open-meteo.com/v1/forecast" +
        "?latitude=" + here.lat +
        "&longitude=" + here.lon +
        "&current=temperature_2m,weather_code,wind_speed_10m" +
        "&daily=sunrise,sunset" +
        "&timezone=auto" +
        "&temperature_unit=fahrenheit" +
        "&wind_speed_unit=mph";

      const response = await realFetch(url, {
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        throw new Error("Weather service error");
      }

      const w = await response.json();

      // Compare local clock times returned by Open-Meteo.
      const toMinutes = (time) => {
        const parts = time.slice(11, 16).split(":");
        return Number(parts[0]) * 60 + Number(parts[1]);
      };

      const now = toMinutes(w.current.time);
      const sunrise = toMinutes(w.daily.sunrise[0]);
      const sunset = toMinutes(w.daily.sunset[0]);

      let daylight;

      if (now < sunrise) {
        daylight =
          sunrise - now <= 60 ? "getting_bright" : "dark";
      } else if (now >= sunset) {
        daylight = "dark";
      } else {
        daylight =
          sunset - now <= 60 ? "getting_dark" : "day";
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
      console.error("Weather error:", err);
      return reply(
        { error: "Could not get the weather." },
        502
      );
    }
  }

  // ---------- Communities ----------
  const MAX_MILES = 25;
  const MAX_METERS = MAX_MILES * 1609.344;

  // ---------- Live dog parks from OpenStreetMap ----------
  async function osmDogParks(zip, here) {
    const cacheKey = "dogwalker:osm:" + zip;
    const CACHE_TIME = 6 * 60 * 60 * 1000;

    // Check cached results.
    try {
      const cached = sessionStorage.getItem(cacheKey);

      if (cached) {
        const saved = JSON.parse(cached);

        if (
          saved.time &&
          Date.now() - saved.time < CACHE_TIME &&
          Array.isArray(saved.places)
        ) {
          console.log("Using cached dog parks.");
          return saved.places;
        }
      }
    } catch (err) {
      console.warn("Could not read dog park cache:", err);
    }

    // Search within 25 miles of the ZIP code.
    const query =
      "[out:json][timeout:25];(" +
      'nwr["leisure"="dog_park"](around:' +
      MAX_METERS +
      "," + here.lat + "," + here.lon + ");" +
      ");out center 80;";

    // Multiple Overpass servers in case one is unavailable.
    const servers = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
      "https://overpass.private.coffee/api/interpreter",
    ];

    for (const url of servers) {
      try {
        console.log("Trying places server:", url);

        const response = await realFetch(url, {
          method: "POST",
          headers: {
            "Content-Type":
              "application/x-www-form-urlencoded",
          },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(12000),
        });

        if (!response.ok) {
          console.warn(
            "Places server returned:",
            response.status
          );
          continue;
        }

        const data = await response.json();

        if (!data.elements) {
          continue;
        }

        const places = data.elements
          .map((el) => {
            const pLat =
              el.lat ??
              (el.center && el.center.lat);

            const pLon =
              el.lon ??
              (el.center && el.center.lon);

            if (
              pLat === undefined ||
              pLon === undefined
            ) {
              return null;
            }

            const meters = Math.round(
              distanceMeters(
                here.lat,
                here.lon,
                pLat,
                pLon
              )
            );

            if (meters > MAX_METERS) {
              return null;
            }

            const name =
              (el.tags && el.tags.name) ||
              "Dog park";

            return {
              name,
              type: "Dog park",
              description: "",
              link:
                "https://www.google.com/maps/search/?api=1&query=" +
                pLat +
                "," +
                pLon,
              meters,
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.meters - b.meters)
          .slice(0, 8);

        console.log("Found dog parks:", places.length);

        // Cache successful results for six hours.
        try {
          sessionStorage.setItem(
            cacheKey,
            JSON.stringify({
              time: Date.now(),
              places,
            })
          );
        } catch (err) {
          console.warn("Could not save dog park cache:", err);
        }

        return places;
      } catch (err) {
        console.warn(
          "Places server failed:",
          url,
          err
        );
      }
    }

    console.error("All OpenStreetMap servers failed.");
    return null;
  }

  // ---------- Get nearby communities ----------
  
async function communities() {
  const zip = load("location", {}).zip;

  if (!zip) {
    return reply(
      { error: "Save a ZIP code to see dog parks near you." },
      400
    );
  }

  const here = await zipInfo(zip);

  if (!here) {
    return reply(
      { error: "Could not find that ZIP code." },
      404
    );
  }

  const live = await osmDogParks(zip, here);

  if (live === null) {
    return reply(
      {
        zip,
        source: "osm",
        places: [],
        error: "Could not connect to the dog park service. Please try again."
      },
      502
    );
  }

  return reply({
    zip,
    source: "osm",
    places: live
  });
}

  // ---------- Request handler ----------
  async function handle(method, path, body) {
    // ---------- Dogs ----------
    if (path === "/api/dogs" && method === "GET") {
      return reply(load("dogs", []));
    }

    if (path === "/api/dogs" && method === "POST") {
      const name = String(
        body.get("dogName") || ""
      ).trim();

      const breed = String(
        body.get("breed") || ""
      ).trim();

      if (!name || !breed) {
        return reply(
          { error: "Name and breed are required." },
          400
        );
      }

      const file = body.get("picture");

      const hasPhoto =
        file &&
        file.size > 0 &&
        file.type.startsWith("image/");

      const picture = hasPhoto
        ? await shrinkPhoto(file)
        : null;

      const dog = {
        id: Date.now(),
        name,
        breed,
        picture,
      };

      const dogs = load("dogs", []);
      dogs.push(dog);
      save("dogs", dogs);

      return reply(dog, 201);
    }

    // ---------- Location ----------
    if (path === "/api/location" && method === "GET") {
      return reply(load("location", {}));
    }

    if (path === "/api/location" && method === "POST") {
      const zip = String(
        (body && body.zip) || ""
      ).trim();

      if (!/^\d{5}$/.test(zip)) {
        return reply(
          { error: "Please enter a valid 5-digit ZIP code." },
          400
        );
      }

      save("location", { zip });

      return reply({ zip });
    }

    // ---------- Walks for one dog ----------
    const walksMatch = path.match(
      /^\/api\/dogs\/([^/]+)\/walks$/
    );

    if (walksMatch) {
      const dogId = decodeURIComponent(
        walksMatch[1]
      );

      if (method === "GET") {
        return reply(
          load("walks", []).filter(
            (w) => String(w.dogId) === dogId
          )
        );
      }

      if (method === "POST") {
        const dog = load("dogs", []).find(
          (d) => String(d.id) === dogId
        );

        if (!dog) {
          return reply(
            { error: "Dog not found." },
            404
          );
        }

        const seconds = Number(body.seconds);
        const startedAt = Number(body.startedAt);

        if (
          !Number.isFinite(seconds) ||
          seconds < 1 ||
          seconds > 24 * 60 * 60
        ) {
          return reply(
            { error: "That walk length doesn't look right." },
            400
          );
        }

        if (!Number.isFinite(startedAt)) {
          return reply(
            { error: "Missing the walk's start time." },
            400
          );
        }

        let meters = 0;

        if (body.meters !== undefined) {
          meters = Number(body.meters);

          if (
            !Number.isFinite(meters) ||
            meters < 0 ||
            meters > 200000
          ) {
            return reply(
              { error: "That distance doesn't look right." },
              400
            );
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

    // ---------- Stats for every dog ----------
    if (path === "/api/stats" && method === "GET") {
      const walks = load("walks", []);

      const stats = load("dogs", []).map((dog) => {
        const mine = walks.filter(
          (w) => String(w.dogId) === String(dog.id)
        );

        return {
          dogId: dog.id,
          name: dog.name,
          walks: mine.length,
          seconds: mine.reduce(
            (sum, w) => sum + (w.seconds || 0),
            0
          ),
          meters: mine.reduce(
            (sum, w) => sum + (w.meters || 0),
            0
          ),
        };
      });

      return reply(stats);
    }

    // ---------- Weather and communities ----------
    if (path === "/api/weather" && method === "GET") {
      return weather();
    }

    if (path === "/api/communities" && method === "GET") {
      return communities();
    }

    return reply(
      { error: "Not found." },
      404
    );
  }

  // ---------- Catch fetch("/api/...") calls ----------
  window.fetch = async function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input.url;

    // Normal requests continue using the real fetch.
    if (!url.startsWith("/api/")) {
      return realFetch(input, init);
    }

    const method = (
      (init && init.method) || "GET"
    ).toUpperCase();

    let body = init && init.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch (err) {
        // Leave non-JSON strings unchanged.
      }
    }

    try {
      return await handle(
        method,
        url.split("?")[0],
        body
      );
    } catch (err) {
      console.error("api.js error:", err);

      return reply(
        {
          error:
            "Something went wrong (browser storage may be full).",
        },
        500
      );
    }
  };
})();
