// U.S. customary display conversions for weather values.
// The Open-Meteo payload stays metric (°C, km/h, mm, m); conversion is display-only.

export const MPH_PER_KPH = 0.621371;
export const MM_PER_INCH = 25.4;
export const METERS_PER_MILE = 1609.344;

export const celsiusToFahrenheit = (c) => (c * 9) / 5 + 32;

/** "72°F", rounded to a whole degree. Caller guarantees a finite Celsius value. */
export const formatTemperatureF = (celsius) => `${Math.round(celsiusToFahrenheit(celsius))}°F`;

/** "12 mph", rounded to a whole mile per hour. Caller guarantees a finite km/h value. */
export const formatWindMph = (kph) => `${Math.round(kph * MPH_PER_KPH)} mph`;

/** Inches to two decimals, no unit ("0.04"). Caller guarantees a finite mm value. */
export const formatPrecipInches = (mm) => (mm / MM_PER_INCH).toFixed(2);
