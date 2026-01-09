// 1. Import necessary packages
const express = require("express");

// 2. Initialize the Express app  ← これを最優先で上に上げる
const app = express();


app.get("/healthz", (req, res) => res.status(200).send("ok"));



// ここから下に他の require を置いてOK（※まだ診断中なので実行されても問題ない）

const cors = require("cors");
const fetch = require("node-fetch"); // Use node-fetch for making requests in Node.js
const axios = require("axios");
const mariadb = require("mariadb"); // Import the MariaDB package
const sweph = require("swisseph"); // Import Swiss Ephemeris for astrological calculations
const { DateTime } = require("luxon");
const cityTimezones = require("city-timezones");
const { createClient } = require("@supabase/supabase-js");

const supabaseUrl = "https://dldezknthsmgskwvhqtk.supabase.co";
const supabaseKey = process.env.SUPABASE_SECRET_KEY;
const supabase = supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;



// 3. Middleware setup
app.use(cors());
app.use(express.json());

// --- /api/swe-test（既存の中身はこの中に戻す） ---
app.get("/api/swe-test", (req, res) => {
  // ここに元の swe-test の処理を書く
  res.json({ ok: true });
});

// --- GAS 本番接続用：出生図エフェメリスAPI ---
app.post("/api/ephemeris", async (req, res) => {
  try {
    const {
      date,
      time,
      tz = "Asia/Tokyo",
      lat,
      lon,
      houseSystem = "Placidus",
      zodiacType = "tropical"
    } = req.body || {};

    if (!date) return res.status(400).json({ error: "date is required" });
    if (lat == null || lon == null) return res.status(400).json({ error: "lat/lon is required" });

    const result = await computeEphemeris({ date, time, tz, lat, lon, houseSystem, zodiacType });

    return res.json({
      planets: result.planets,
      houses: result.houses,
      meta: {
        hasBirthTime: !!time && time !== "00:00",
        houseSystem,
        zodiacType,
        tz,
        lat,
        lon
      }
    });
  } catch (e) {
    console.error("ephemeris failed:", e);
    return res.status(500).json({ error: "ephemeris failed" });
  }
});

// --- /api/planets（あなたのコードをそのまま） ---
app.get("/api/planets", (req, res) => {
  try {
    const date = req.query.date;
    const dt = DateTime.fromISO(date, { zone: "Asia/Tokyo" }).set({ hour: 12 });

    const jd = sweph.swe_julday(dt.year, dt.month, dt.day, 12, sweph.SE_GREG_CAL);

    // ephe path は本番で要注意（後述）
    sweph.swe_set_ephe_path("/mnt/c/swe-api/pythia-api/eph");

    const planets = {
      Sun: sweph.SE_SUN,
      Moon: sweph.SE_MOON,
      Mercury: sweph.SE_MERCURY,
      Venus: sweph.SE_VENUS,
      Mars: sweph.SE_MARS,
      Jupiter: sweph.SE_JUPITER,
      Saturn: sweph.SE_SATURN,
      Uranus: sweph.SE_URANUS,
      Neptune: sweph.SE_NEPTUNE,
      Pluto: sweph.SE_PLUTO
    };

    let result = {};
    for (const [name, id] of Object.entries(planets)) {
      const r = sweph.swe_calc_ut(jd, id, sweph.SEFLG_SWIEPH);
      result[name] = r.data[0];
    }

    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

    // ephフォルダを明示（安定）
    sweph.swe_set_ephe_path(process.env.EPHE_PATH || "./eph");

    // swisseph は callback で返る
    sweph.swe_calc_ut(jd, sweph.SE_SUN, sweph.SEFLG_SWIEPH, (ret) => {
      if (!ret) return res.status(500).json({ ok: false, error: "No return from swe_calc_ut" });
      if (ret.error) return res.status(500).json({ ok: false, error: ret.error });

      // ✅ このswissephは longitude 形式で返す
      if (typeof ret.longitude !== "number") {
        return res.status(500).json({ ok: false, error: "Unexpected swe_calc_ut return shape", ret });
      }

      res.json({
        ok: true,
        utc: now.toISO(),
        sun_lon: ret.longitude,
        sun_lat: ret.latitude,
        distance: ret.distance,
        rflag: ret.rflag,
      });
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 4. MariaDB Connection Pool
// Use the connection details provided to connect to your database.
// 4. MariaDB Connection Pool (Using Environment Variables)
const hasDb =
  process.env.DB_HOST &&
  process.env.DB_USER &&
  process.env.DB_PASSWORD &&
  process.env.DB_DATABASE;

const pool = hasDb
  ? mariadb.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      connectionLimit: 5,
      supportBigNumbers: true,
      insertIdAsNumber: true,
    })
  : null;

if (!pool) {
  console.warn("DB env not set: MariaDB disabled (OK for local run).");
}

// --- Helper Functions ---

// A helper function to log key chart placements in a readable format
function logChartSummary(chart, title = "Chart Summary") {
  if (!chart) {
    console.log(`-- ${title}: Invalid chart data provided --`);
    return;
  }

  console.log(`\n--- ${title} ---`);

  // Log Angles (Ascendant & MC) if the chart has houses
  if (chart.houses && chart.houses.ascendant) {
    const asc = getZodiacSign(chart.houses.ascendant);
    const mc = getZodiacSign(chart.houses.mc);
    console.log(`Ascendant: ${asc.degrees.toFixed(2)}° ${asc.sign}`);
    console.log(`MC:        ${mc.degrees.toFixed(2)}° ${mc.sign}`);
    console.log(`---------------------------------`);
  }

  // Log all planets and bodies from the positions object
  if (chart.positions) {
    const planetNames = Object.keys(chart.positions);
    // Find the longest name for clean padding
    const longestName = Math.max(...planetNames.map((name) => name.length));

    for (const planetName of planetNames) {
      const planetData = chart.positions[planetName];
      if (
        !planetData ||
        typeof planetData.sign_degrees !== "number" ||
        !planetData.sign
      )
        continue;

      const paddedName = planetName.padEnd(longestName, " ");
      const degrees = planetData.sign_degrees.toFixed(2).padStart(5, " ");
      const sign = planetData.sign.padEnd(11, " ");

      // Only show house if it exists on the object
      const house = planetData.house
        ? `(H${String(planetData.house).padStart(2, " ")})`
        : "";

      console.log(`${paddedName}: ${degrees}° ${sign} ${house}`);
    }
  }

  console.log(`---------------------------------\n`);
}

/**
 * Determines the zodiac sign and degree within that sign from a celestial longitude.
 * @param {number} longitude - The celestial longitude in degrees (0-360).
 * @returns {{sign: string, degrees: number}} - The zodiac sign and the degree within it.
 */
const getZodiacSign = (longitude) => {
  const signs = [
    "Aries",
    "Taurus",
    "Gemini",
    "Cancer",
    "Leo",
    "Virgo",
    "Libra",
    "Scorpio",
    "Sagittarius",
    "Capricorn",
    "Aquarius",
    "Pisces",
  ];
  const signIndex = Math.floor(longitude / 30);
  const degreesInSign = longitude % 30;
  return {
    sign: signs[signIndex],
    degrees: degreesInSign,
  };
};

/**
 * Determines the house placement of a celestial body.
 * @param {number} longitude - The celestial longitude of the planet.
 * @param {Array<number>} houseCusps - An array of 12 house cusp longitudes.
 * @returns {number | null} - The house number (1-12) or null if not found.
 */
const getHousePlacement = (longitude, houseCusps) => {
  if (!houseCusps || houseCusps.length < 12) return null;
  for (let i = 0; i < 12; i++) {
    const cusp1 = houseCusps[i];
    const cusp2 = houseCusps[(i + 1) % 12]; // Next cusp, wraps around from 12 to 1
    if (cusp1 > cusp2) {
      // Handle the case where the house crosses the 0° Aries point
      if (longitude >= cusp1 || longitude < cusp2) return i + 1;
    } else {
      if (longitude >= cusp1 && longitude < cusp2) return i + 1;
    }
  }
  return null;
};

/**
 * Main helper function to perform all astrological calculations.
 * @param {number} year - The year of the event.
 * @param {number} month - The month of the event.
 * @param {number} day - The day of the event.
 * @param {string} time - The time of the event (e.g., "14:30").
 * @param {string} location - The location of the event.
 * @returns {Promise<object>} - A promise that resolves to the complete chart data object.
 * @throws {Error} - Throws an error if any part of the calculation fails.
 */
async function calculateChart(
  year,
  month,
  day,
  time,
  location,
  includeHouses = true, // ✅ New optional parameter
  houseSystem = "P" // Default house system
) {
  // --- 1. Geocoding and Timezone Conversion ---
  // This step is still needed to convert the local time to the correct Universal Time (UT),
  // as the timezone is derived from the location.
  const geocodingApiKey = process.env.GEOCODING_API_KEY;
  if (!geocodingApiKey) {
    throw new Error("GEOCODING_API_KEY not found on the server.");
  }

  const geocodeUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
    location
  )}&key=${geocodingApiKey}`;
  const geocodeResponse = await axios.get(geocodeUrl);
  const geoData = geocodeResponse.data;

  if (geoData.status !== "OK" || !geoData.results[0]) {
    throw new Error("Could not geocode the provided location.");
  }

  const { lat, lng } = geoData.results[0].geometry.location;
  const formattedLocation = geoData.results[0].formatted_address;

  const isoString = `${year}-${String(month).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}T${time}`;
  const localTime = DateTime.fromISO(isoString);

  const timezoneUrl = `https://maps.googleapis.com/maps/api/timezone/json?location=${lat},${lng}&timestamp=${localTime.toSeconds()}&key=${geocodingApiKey}`;
  const timezoneResponse = await axios.get(timezoneUrl);
  const tzData = timezoneResponse.data;

  if (tzData.status !== "OK") {
    throw new Error("Could not determine the timezone for the location.");
  }

  const utcTime = DateTime.fromISO(isoString, {
    zone: tzData.timeZoneId,
  }).toUTC();
  if (!utcTime.isValid) {
    throw new Error(`Invalid date or time provided: ${utcTime.invalidReason}`);
  }

  // --- 2. Astrological Calculations using Swiss Ephemeris ---
  sweph.swe_set_ephe_path(__dirname + "/ephe");

  const julianDayUT = sweph.swe_julday(
    utcTime.year,
    utcTime.month,
    utcTime.day,
    utcTime.hour + utcTime.minute / 60 + utcTime.second / 3600,
    sweph.SE_GREG_CAL
  );

  const chartData = {
    meta: {
      date: utcTime.toFormat("yyyy-MM-dd HH:mm:ss 'UTC'"),
      location: formattedLocation,
      latitude: lat,
      longitude: lng,
      inputs: { year, month, day, time, location },
    },
    positions: {},
    houses: null, // Default to null
    aspects: [],
  };

  // --- 3. House Calculation (Now Conditional) ---
  if (includeHouses) {
    const housesResult = sweph.swe_houses(julianDayUT, lat, lng, houseSystem);
    if (housesResult.error) {
      throw new Error(`House calculation failed: ${housesResult.error}`);
    }
    chartData.houses = {
      system: houseSystem,
      ascendant: housesResult.asc,
      mc: housesResult.mc,
      cusps: housesResult.house.slice(0, 12),
    };
  }

  // --- 4. Planet Calculation ---
  const planets = {
    Sun: sweph.SE_SUN,
    Moon: sweph.SE_MOON,
    Mercury: sweph.SE_MERCURY,
    Venus: sweph.SE_VENUS,
    Mars: sweph.SE_MARS,
    Jupiter: sweph.SE_JUPITER,
    Saturn: sweph.SE_SATURN,
    Uranus: sweph.SE_URANUS,
    Neptune: sweph.SE_NEPTUNE,
    Pluto: sweph.SE_PLUTO,
    "North Node": sweph.SE_TRUE_NODE,
    Chiron: sweph.SE_CHIRON,
  };

  for (const [name, id] of Object.entries(planets)) {
    const result = sweph.swe_calc_ut(
      julianDayUT,
      id,
      sweph.SEFLG_SPEED | sweph.SEFLG_JPLEPH
    );
    if (result.error) {
      console.warn(`Swiss Ephemeris warning for ${name}:`, result.error);
      continue;
    }
    const signInfo = getZodiacSign(result.longitude);

    // Build the position data object
    const positionData = {
      longitude: result.longitude,
      latitude: result.latitude,
      speed: result.speed,
      sign: signInfo.sign,
      sign_degrees: signInfo.degrees,
    };

    // ✅ Conditionally add house placement
    if (includeHouses && chartData.houses) {
      positionData.house = getHousePlacement(
        result.longitude,
        chartData.houses.cusps
      );
    }

    chartData.positions[name] = positionData;
  }

  // --- 5. Aspect Calculation (Unaffected by houses) ---
  const aspectTypes = {
    conjunction: { angle: 0, orb: 8, color: "#4a4a4a" },
    opposition: { angle: 180, orb: 8, color: "#ff4d4d" },
    trine: { angle: 120, orb: 8, color: "#2b8a3e" },
    square: { angle: 90, orb: 8, color: "#e03131" },
    sextile: { angle: 60, orb: 6, color: "#1c7ed6" },
    quincunx: { angle: 150, orb: 3, color: "#f08c00" },
  };

  const planetNames = Object.keys(chartData.positions);
  for (let i = 0; i < planetNames.length; i++) {
    for (let j = i + 1; j < planetNames.length; j++) {
      const p1 = chartData.positions[planetNames[i]];
      const p2 = chartData.positions[planetNames[j]];
      if (!p1 || !p2) continue;
      let angle = Math.abs(p1.longitude - p2.longitude);
      if (angle > 180) angle = 360 - angle;
      for (const aspectName in aspectTypes) {
        const aspect = aspectTypes[aspectName];
        if (Math.abs(angle - aspect.angle) <= aspect.orb) {
          chartData.aspects.push({
            planet1: planetNames[i],
            planet2: planetNames[j],
            aspect: aspectName,
            orb: Math.abs(angle - aspect.angle),
            color: aspect.color,
          });
          break;
        }
      }
    }
  }

  // --- 6. Cleanup ---
  sweph.swe_close();

  return chartData;
}

async function recalculateAllChartsOnStartup() {
  console.log("🚀 Starting recalculation of all saved astro charts...");
  let conn;
  try {
    conn = await pool.getConnection();

    const queryResult = await conn.query(
      "SELECT event_id, event_data FROM astro_event_data"
    );

    let events = [];
    if (queryResult) {
      if (Array.isArray(queryResult)) {
        events = queryResult;
      } else if (typeof queryResult === "object" && queryResult !== null) {
        events = [queryResult];
      }
    }

    if (events.length === 0) {
      console.log("No saved charts to recalculate. Startup complete.");
      if (conn) conn.release();
      return;
    }

    console.log(`Found ${events.length} charts to process.`);

    for (const event of events) {
      try {
        const eventId = event.event_id;
        let data;
        if (typeof event.event_data === "string") {
          data = JSON.parse(event.event_data);
        } else {
          data = event.event_data;
        }

        let inputs;
        if (data.meta && data.meta.inputs) {
          inputs = data.meta.inputs;
        } else if (data.meta && data.meta.date && data.meta.location) {
          console.log(
            `Event ID ${eventId} is old format, reconstructing inputs...`
          );

          const dateString = data.meta.date.replace(" UTC", "");
          const utcDate = DateTime.fromSQL(dateString, { zone: "utc" });

          if (utcDate.isValid) {
            inputs = {
              year: utcDate.year,
              month: utcDate.month,
              day: utcDate.day,
              time: utcDate.toFormat("HH:mm:ss"),
              location: data.meta.location,
            };

            // ✅ ADD THIS LOGGING to verify the reconstructed inputs
            console.log(`---> Reconstructed for Event ${eventId}:`, inputs);
          }
        }

        if (
          !inputs ||
          !inputs.year ||
          !inputs.month ||
          !inputs.day ||
          !inputs.time ||
          !inputs.location
        ) {
          console.warn(
            `Skipping event ID ${eventId}: Missing or invalid input data even after fallback.`
          );
          continue;
        }

        console.log(`Recalculating chart for event ID: ${eventId}...`);

        const recalculatedChartData = await calculateChart(
          inputs.year,
          inputs.month,
          inputs.day,
          inputs.time,
          inputs.location
        );

        const updateQuery =
          "UPDATE astro_event_data SET event_data = ? WHERE event_id = ?";
        await conn.query(updateQuery, [
          JSON.stringify(recalculatedChartData),
          eventId,
        ]);

        console.log(
          `✅ Successfully recalculated chart for event ID: ${eventId}`
        );
      } catch (recalcError) {
        console.error(
          `❌ Failed to recalculate chart for event ID ${event.event_id}:`,
          recalcError.message
        );
      }
    }

    console.log("✨ Chart recalculation process finished successfully.");
  } catch (err) {
    console.error(
      "A critical error occurred during the chart recalculation process:",
      err.message
    );
  } finally {
    if (conn) conn.release();
  }
}

app.put("/api/astro-event/:eventId", async (req, res) => {
  const { authorization } = req.headers;
  const { eventId } = req.params;
  const updatedFields = req.body;

  let conn;
  if (!authorization) {
    return res.status(400).json({
      response:
        "Missing JWT token in Authorization header. Please provide a valid JWT token",
    });
  }

  try {
    const verified = await supabase.auth.getUser(authorization);
    if (!verified?.data?.user) {
      return res.status(400).json({
        response: "Invalid JWT token",
      });
    }

    if (verified.data.user.id !== updatedFields.userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You can only update your own events.",
      });
    }

    if (!eventId || isNaN(parseInt(eventId))) {
      return res
        .status(400)
        .json({ error: "A valid eventId must be provided." });
    }

    conn = await pool.getConnection();

    const queryResult = await conn.query(
      "SELECT event_data, label FROM astro_event_data WHERE user_id = ? AND event_id = ?",
      [updatedFields.userId, eventId]
    );

    const rows = queryResult
      ? Array.isArray(queryResult)
        ? queryResult
        : [queryResult]
      : [];

    if (rows.length === 0) {
      return res
        .status(404)
        .json({ error: `Event with ID ${eventId} not found for this user.` });
    }

    const existingEvent = rows[0];

    // ✅ CORRECTED: Check if event_data is a string before attempting to parse it.
    const existingData =
      typeof existingEvent.event_data === "string"
        ? JSON.parse(existingEvent.event_data)
        : existingEvent.event_data;

    const existingLabel = existingEvent.label;

    const newInputs = { ...existingData.meta.inputs, ...updatedFields };
    const newLabel = updatedFields.label || existingLabel;

    const { year, month, day, time, location, houseSystem } = newInputs;
    if (!year || !month || !day || !time || !location) {
      return res.status(400).json({
        error: "Update would result in missing date, time, or location.",
      });
    }
    const recalculatedChartData = await calculateChart(
      year,
      month,
      day,
      time,
      location,
      houseSystem
    );

    const updateQuery = `
      UPDATE astro_event_data 
      SET label = ?, event_data = ? 
      WHERE event_id = ?;
    `;
    await conn.query(updateQuery, [
      newLabel,
      JSON.stringify(recalculatedChartData),
      eventId,
    ]);

    recalculatedChartData.event_id = parseInt(eventId);
    logChartSummary(
      recalculatedChartData,
      `Updated Chart Sent for "${newLabel}"`
    );
    res.status(200).json(recalculatedChartData);
  } catch (err) {
    console.error(`PUT /api/astro-event Error:`, err.message);
    res.status(500).json({
      error: "An error occurred while updating the event.",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

app.delete("/api/astro-event/:eventId", async (req, res) => {
  const { authorization } = req.headers;
  const { eventId } = req.params;

  let conn;
  if (!authorization) {
    return res.status(400).json({
      response:
        "Missing JWT token in Authorization header. Please provide a valid JWT token",
    });
  }

  const verified = await supabase.auth.getUser(authorization);
  if (!verified?.data?.user) {
    return res.status(400).json({
      response: "Invalid JWT token",
    });
  }

  // Security check: ensure the requesting user is the one they're asking for data about
  if (verified.data.user.id !== userId) {
    return res.status(403).json({
      success: false,
      message: "Forbidden: You can only request your own data.",
    });
  }
  try {
    // --- Validation ---
    if (!eventId || isNaN(parseInt(eventId))) {
      return res
        .status(400)
        .json({ error: "A valid eventId must be provided in the URL." });
    }

    // --- Database Deletion ---
    conn = await pool.getConnection();
    const deleteQuery = `
      DELETE FROM astro_event_data 
      WHERE event_id = ?;
    `;
    const result = await conn.query(deleteQuery, [eventId]);

    // Check if a row was deleted
    if (result.affectedRows === 0) {
      return res
        .status(404)
        .json({ error: `Event with ID ${eventId} not found.` });
    }

    // --- Send Success Response ---
    res
      .status(200)
      .json({ message: `Event with ID ${eventId} was deleted successfully.` });
  } catch (err) {
    console.error("Delete Event Error:", err.message);
    res.status(500).json({
      error: "An error occurred while deleting the event.",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

app.get("/api/events/:userId", async (req, res) => {
  const { authorization } = req.headers;
  const { userId } = req.params;

  let conn;
  if (!authorization) {
    return res.status(400).json({
      response:
        "Missing JWT token in Authorization header. Please provide a valid JWT token",
    });
  }

  try {
    const verified = await supabase.auth.getUser(authorization);
    if (!verified?.data?.user) {
      return res.status(400).json({
        response: "Invalid JWT token",
      });
    }

    if (verified.data.user.id !== userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You can only request your own data.",
      });
    }

    if (!userId) {
      return res
        .status(400)
        .json({ error: "User ID is required in the URL path." });
    }

    conn = await pool.getConnection();
    const query =
      "SELECT * FROM astro_event_data WHERE user_id = ? ORDER BY created_at DESC";
    const rows = await conn.query(query, [userId]);

    const events = rows.map((row) => {
      let parsedData;
      if (typeof row.event_data === "string") {
        try {
          parsedData = JSON.parse(row.event_data);
        } catch (e) {
          console.error(
            `Failed to parse event_data for event_id ${row.event_id}:`,
            e
          );
          parsedData = {
            error: "Failed to parse malformed JSON data from database.",
          };
        }
      } else {
        parsedData = row.event_data;
      }

      return {
        ...row,
        event_data: parsedData,
      };
    });

    // ✅ ADDED: Human-readable log for each event being sent to the client.
    console.log(`\n--- Sending ${events.length} Event(s) to Client ---`);
    events.forEach((event) => {
      logChartSummary(event.event_data, `Chart for "${event.label}"`);
    });
    console.log(`-------------------------------------\n`);

    res.json(events);
  } catch (err) {
    console.error("Fetch Events Error:", err.message);
    res.status(500).json({
      error: "An error occurred while fetching event data.",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

app.post("/api/natal-chart", async (req, res) => {
  const { authorization } = req.headers;
  const { userId, label, year, month, day, time, location } = req.body;

  let conn;
  if (!authorization) {
    return res.status(400).json({
      response:
        "Missing JWT token in Authorization header. Please provide a valid JWT token",
    });
  }

  try {
    const verified = await supabase.auth.getUser(authorization);
    if (!verified?.data?.user) {
      return res.status(400).json({
        response: "Invalid JWT token",
      });
    }

    // ✅ CORRECTED: Security check now correctly compares the verified token's user ID
    // with the userId sent in the request body.
    if (verified.data.user.id !== userId) {
      return res.status(403).json({
        success: false,
        message:
          "Forbidden: You can only create events for your own user account.",
      });
    }

    if (!userId || !label || !year || !month || !day || !time || !location) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // Use the reusable helper to get all chart data
    const chartData = await calculateChart(year, month, day, time, location);

    // ✅ ADDED: Human-readable log of the created chart
    logChartSummary(chartData, `Natal Chart Created for "${label}"`);

    // --- Save to Database ---
    conn = await pool.getConnection();
    const insertQuery = `
      INSERT INTO astro_event_data (user_id, label, event_data) 
      VALUES (?, ?, ?);
    `;
    const eventDataString = JSON.stringify(chartData);
    const dbResult = await conn.query(insertQuery, [
      userId,
      label,
      eventDataString,
    ]);
    chartData.event_id = Number(dbResult.insertId);

    res.status(201).json(chartData);
  } catch (err) {
    console.error("POST /api/natal-chart Error:", err.message);
    res.status(500).json({
      error: "An error occurred while creating the natal chart.",
      details: err.message,
    });
  } finally {
    if (conn) conn.release();
  }
});

// ===============================
// Transit Important Months API
// ===============================

// Swiss Ephemeris constants map
const PLANETS = {
  Sun: sweph.SE_SUN,
  Moon: sweph.SE_MOON,
  Mercury: sweph.SE_MERCURY,
  Venus: sweph.SE_VENUS,
  Mars: sweph.SE_MARS,
  Jupiter: sweph.SE_JUPITER,
  Saturn: sweph.SE_SATURN,
  Uranus: sweph.SE_URANUS,
  Neptune: sweph.SE_NEPTUNE,
  Pluto: sweph.SE_PLUTO,
};

// Aspects (degrees)
const ASPECTS = [
  { name: "conjunction", deg: 0 },
  { name: "sextile", deg: 60 },
  { name: "square", deg: 90 },
  { name: "trine", deg: 120 },
  { name: "opposition", deg: 180 },
];

// Normalize angle to 0..360
function norm360(x) {
  let v = x % 360;
  if (v < 0) v += 360;
  return v;
}

// Smallest angular distance 0..180
function angDist(a, b) {
  const d = Math.abs(norm360(a) - norm360(b));
  return d > 180 ? 360 - d : d;
}

// Promise wrapper for swe_calc_ut that returns longitude etc.
function sweCalcUtAsync(jd, planetId, flags) {
  return new Promise((resolve, reject) => {
    sweph.swe_calc_ut(jd, planetId, flags, (ret) => {
      if (!ret) return reject(new Error("No return from swe_calc_ut"));
      if (ret.error) return reject(new Error(ret.error));
      if (typeof ret.longitude !== "number") {
        return reject(new Error("Unexpected swe_calc_ut return shape"));
      }
      resolve(ret);
    });
  });
}

// Build JD from a Luxon DateTime (UTC)
function toJulianDayUTC(dtUtc) {
  return sweph.swe_julday(
    dtUtc.year,
    dtUtc.month,
    dtUtc.day,
    dtUtc.hour + dtUtc.minute / 60 + dtUtc.second / 3600,
    sweph.SE_GREG_CAL
  );
}

// Get planet longitudes at UTC datetime
async function getPlanetLongitudesUTC(dtUtc, planetNames) {
  const jd = toJulianDayUTC(dtUtc);
  const flags = sweph.SEFLG_SWIEPH; // enough for longitude
  const out = {};
  for (const name of planetNames) {
    const ret = await sweCalcUtAsync(jd, PLANETS[name], flags);
    out[name] = ret.longitude;
  }
  return out;
}

// Score rules (まずは実用最優先の“簡易版”)
// - 木星: 吉（合/120/60）
// - 土星: 責任・試練（合/90/180）
// - 天王星: 変化（合/90/180）
// ※ 必要ならここは後であなた用にチューニングする
function scoreHit(transitPlanet, aspectName, natalPlanet) {
  // base weights
  const rules = {
    Jupiter: { conjunction: 3, trine: 3, sextile: 2, square: 1, opposition: 1 },
    Saturn: { conjunction: 3, square: 3, opposition: 3, trine: 1, sextile: 1 },
    Uranus: { conjunction: 3, square: 3, opposition: 3, trine: 1, sextile: 1 },
    Neptune: { conjunction: 2, square: 2, opposition: 2, trine: 1, sextile: 1 },
    Pluto: { conjunction: 3, square: 3, opposition: 3, trine: 1, sextile: 1 },
  };
  const byPlanet = rules[transitPlanet];
  if (!byPlanet) return 0;
  const base = byPlanet[aspectName] || 0;

  // natal importance tweak (Sun/Moon/Venus/Marsは少し強め)
  const natalBoost = ["Sun", "Moon", "Venus", "Mars"].includes(natalPlanet) ? 1 : 0;

  return base + natalBoost;
}

// Orb settings (度)
function orbFor(transitPlanet) {
  // 遅い天体は少し広め
  if (["Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"].includes(transitPlanet)) return 1.5;
  return 1.0;
}

// Find aspect hits between transit and natal longitudes
function findAspectHitsForDay(dateISO, transitLons, natalLons) {
  const hits = [];
  const transitPlanets = Object.keys(transitLons);
  const natalPlanets = Object.keys(natalLons);

  for (const tName of transitPlanets) {
    const tLon = transitLons[tName];
    const orb = orbFor(tName);

    for (const nName of natalPlanets) {
      const nLon = natalLons[nName];
      const d = angDist(tLon, nLon);

      for (const asp of ASPECTS) {
        const diff = Math.abs(d - asp.deg);
        if (diff <= orb) {
          const score = scoreHit(tName, asp.name, nName);
          if (score > 0) {
            hits.push({
              date: dateISO,
              transitPlanet: tName,
              natalPlanet: nName,
              aspect: asp.name,
              exactDiffDeg: Number(diff.toFixed(3)),
              score,
            });
          }
        }
      }
    }
  }
  return hits;
}

// POST /api/important-months
// body:
// {
//   "year": 2026,
//   "birth": {
//     "iso": "1990-05-01T13:25:00+09:00"
//   }
// }
app.post("/api/important-months", async (req, res) => {
  try {
    // eph path (あなたの環境に合わせて固定)
    sweph.swe_set_ephe_path("/mnt/c/swe-api/pythia-api/eph");

    const year = Number(req.body?.year);
    const birthIso = req.body?.birth?.iso;

    if (!year || !birthIso) {
      return res.status(400).json({
        ok: false,
        error: "Missing required fields. Provide { year, birth: { iso } } (ISO8601 with timezone).",
      });
    }

    // birth datetime (must include timezone offset like +09:00)
    const birth = DateTime.fromISO(birthIso, { setZone: true });
    if (!birth.isValid) {
      return res.status(400).json({ ok: false, error: "Invalid birth.iso. Must be ISO8601 with timezone." });
    }
    const birthUtc = birth.toUTC();

    // Natal planets (必要最低限で開始：太陽/月/金星/火星/木星/土星)
    const natalPlanetList = ["Sun", "Moon", "Venus", "Mars", "Jupiter", "Saturn"];
    const natalLons = await getPlanetLongitudesUTC(birthUtc, natalPlanetList);

    // Transits: 遅い天体中心（重要月が出やすい）
    const transitPlanetList = ["Jupiter", "Saturn", "Uranus", "Neptune", "Pluto"];

    // Scan daily at 12:00 UTC (誤差を抑えつつ簡単)
    const start = DateTime.utc(year, 1, 1, 12, 0, 0);
    const end = DateTime.utc(year + 1, 1, 1, 12, 0, 0);

    const monthAgg = new Map(); // key: YYYY-MM -> {scoreTotal, bestHit, hitsCount}
    const allHits = [];

    for (let dt = start; dt < end; dt = dt.plus({ days: 1 })) {
      const dateISO = dt.toISODate(); // YYYY-MM-DD
      const transitLons = await getPlanetLongitudesUTC(dt, transitPlanetList);
      const hits = findAspectHitsForDay(dateISO, transitLons, natalLons);

      if (hits.length) {
        allHits.push(...hits);
        const monthKey = dt.toFormat("yyyy-LL");
        const monthScore = hits.reduce((s, h) => s + h.score, 0);
        const bestHit = hits.reduce((best, h) => (h.score > (best?.score ?? -1) ? h : best), null);

        const cur = monthAgg.get(monthKey) || { month: monthKey, scoreTotal: 0, bestHit: null, hitsCount: 0 };
        cur.scoreTotal += monthScore;
        cur.hitsCount += hits.length;

        // keep strongest single hit in that month
        if (!cur.bestHit || bestHit.score > cur.bestHit.score) cur.bestHit = bestHit;

        monthAgg.set(monthKey, cur);
      }
    }

    const months = Array.from(monthAgg.values()).sort((a, b) => b.scoreTotal - a.scoreTotal);
    const top3 = months.slice(0, 3);

    return res.json({
      ok: true,
      year,
      birth: { iso: birth.toISO(), utc: birthUtc.toISO() },
      natal: natalLons,
      importantMonths: top3,
      // 全ヒットが多い場合があるので、必要なら後で絞る
      hitsPreview: allHits.slice(0, 50),
      hitsTotal: allHits.length,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e) });
  }
});


app.post("/api/query", async (req, res) => {
  const { authorization } = req.headers;
  const {
    userId,
    chartData,
    userQuestion,
    transitTimestamp,
    progressed,
    progressedEventIds,
    progressedTimezones,
    houseSystem = "P",
  } = req.body;

  let conn;

  if (!authorization) {
    return res.status(400).json({
      response:
        "Missing JWT token in Authorization header. Please provide a valid JWT token",
    });
  }

  try {
    const verified = await supabase.auth.getUser(authorization);
    if (!verified?.data?.user) {
      return res.status(400).json({ response: "Invalid JWT token" });
    }

    if (verified.data.user.id !== userId) {
      return res.status(403).json({
        success: false,
        message: "Forbidden: You can only request your own data.",
      });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    console.log(`User ${userId} made a query: ${userQuestion}`);

    if (!apiKey) {
      return res
        .status(500)
        .json({ error: "GEMINI_API_KEY not found on the server." });
    }
    if (!userId || !chartData || !userQuestion) {
      return res.status(400).json({
        error: "Missing userId, chartData, or userQuestion in the request.",
      });
    }

    let finalChartDataString = chartData;
    let additionalContext = "";

    if (
      progressed === true &&
      Array.isArray(progressedEventIds) &&
      progressedEventIds.length > 0
    ) {
      try {
        let charts = JSON.parse(chartData);
        if (!Array.isArray(charts)) charts = [charts];
        const updatedCharts = await Promise.all(
          charts.map(async (chart) => {
            if (progressedEventIds.includes(chart.event_id)) {
              const birthDate = DateTime.fromISO(chart.event_data.meta.date);
              const natalLocation = chart.event_data.meta.location;
              const customTimezone = progressedTimezones[chart.event_id];
              if (birthDate.isValid && natalLocation) {
                const ageInYears = DateTime.now().diff(
                  birthDate,
                  "years"
                ).years;
                const progressedDate = birthDate.plus({ days: ageInYears });

                let locationForCalc = natalLocation;
                if (customTimezone) {
                  // ✅ CORRECTED: Use cityTimezones.cityMapping.find()
                  const cityData = cityTimezones.cityMapping.find(
                    (c) => c.timezone === customTimezone
                  );
                  if (cityData) {
                    locationForCalc = `${cityData.city}, ${cityData.country}`;
                  }
                }

                const progressedChartData = await calculateChart(
                  progressedDate.year,
                  progressedDate.month,
                  progressedDate.day,
                  progressedDate.toFormat("HH:mm:ss"),
                  locationForCalc,
                  false,
                  houseSystem
                );
                logChartSummary(
                  progressedChartData,
                  `Progressed Chart for Event ID ${chart.event_id}`
                );
                chart.progressedChart = progressedChartData;
              }
            }
            return chart;
          })
        );
        finalChartDataString = JSON.stringify(updatedCharts, null, 2);
      } catch (e) {
        console.error("Error processing progressed charts:", e.message);
      }
    }

    if (transitTimestamp) {
      try {
        const transitDate = DateTime.fromISO(transitTimestamp, {
          setZone: true,
        });
        if (transitDate.isValid) {
          // ✅ CORRECTED: Use cityTimezones.cityMapping.find()
          const cityData = cityTimezones.cityMapping.find(
            (c) => c.timezone === transitDate.zoneName
          );
          const transitLocation = cityData
            ? `${cityData.city}, ${cityData.country}`
            : "Greenwich, UK";

          const transitChart = await calculateChart(
            transitDate.year,
            transitDate.month,
            transitDate.day,
            transitDate.toFormat("HH:mm:ss"),
            transitLocation,
            false,
            houseSystem
          );
          logChartSummary(
            transitChart,
            `Transit Chart for ${transitDate.toFormat("yyyy-MM-dd")}`
          );
          additionalContext = `\n\n**Transit Chart for ${transitDate.toFormat(
            "yyyy-MM-dd HH:mm"
          )}:**\n---\n${JSON.stringify(transitChart, null, 2)}\n---`;
        }
      } catch (e) {
        console.error("Error processing transit chart:", e.message);
      }
    }

    conn = await pool.getConnection();
    const checkQuery = `SELECT queries_today, last_query_timestamp FROM user_query_stats WHERE user_id = ?`;
    const queryResult = await conn.query(checkQuery, [userId]);
    const userStats = queryResult
      ? Array.isArray(queryResult)
        ? queryResult
        : [queryResult]
      : [];

    if (userStats.length > 0) {
      const today = new Date().toDateString();
      const lastQueryDay = new Date(
        userStats[0].last_query_timestamp
      ).toDateString();
      if (today === lastQueryDay && userStats[0].queries_today >= 30) {
        if (conn) conn.release();
        return res
          .status(429)
          .json({ error: "Query limit of 30 per day reached." });
      }
    }

    const prompt = `
      You are an expert astrologer with deep knowledge of various astrological techniques including natal charts, synastry, composite charts, progressed charts, astrocartography, and zodiacal releasing.
      Analyze the following astrological data and answer the user's question based on it. Provide a thoughtful, detailed, and insightful interpretation without unnecessary flattery.
      **Astrological Data:**
      ---
      ${finalChartDataString}
      ---
      ${additionalContext}
      **User's Question:**
      ${userQuestion}
      **Your Interpretation:**
    `;

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
    const geminiResponse = await axios.post(
      apiUrl,
      {
        contents: [{ parts: [{ text: prompt }] }],
      },
      { headers: { "Content-Type": "application/json" } }
    );

    const data = geminiResponse.data;
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      if (conn) conn.release();
      return res
        .status(500)
        .json({ error: "The response from the AI was empty or malformed." });
    }

    if (userStats.length > 0) {
      const today = new Date().toDateString();
      const lastQueryDay = new Date(
        userStats[0].last_query_timestamp
      ).toDateString();
      const updateQuery =
        today === lastQueryDay
          ? `UPDATE user_query_stats SET queries_today = queries_today + 1, last_query_timestamp = NOW() WHERE user_id = ?`
          : `UPDATE user_query_stats SET queries_today = 1, last_query_timestamp = NOW() WHERE user_id = ?`;
      await conn.query(updateQuery, [userId]);
    } else {
      const insertQuery = `INSERT INTO user_query_stats (user_id, queries_today, last_query_timestamp) VALUES (?, 1, NOW())`;
      await conn.query(insertQuery, [userId]);
    }

    res.json({ response: text });
  } catch (err) {
    console.error("Server Error:", err);
    res
      .status(500)
      .json({ error: err.message || "An unknown server error occurred." });
  } finally {
    if (conn) conn.release();
  }
});
// 6. Start the server
// 6. Start the server
// 6. Start the server
const PORT = process.env.PORT || 8080;


app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server is running on port ${PORT}`);

  if (pool) {
    Promise.resolve()
      .then(() => recalculateAllChartsOnStartup())
      .catch(e => console.error("recalc failed:", e));
  } else {
    console.log("Skipping chart recalculation (DB disabled).");
  }
});
