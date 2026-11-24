// Location-based service: browser Geolocation API + BigDataCloud reverse geocoding
// (coordinates -> country and city). Works on https or on http://localhost.

import { load, save } from './storage.js';

const ERRORS = {
  1: 'Location permission was denied. You can still pick a country from the list.',
  2: 'Your position could not be found right now.',
  3: 'Finding your location took too long. Please try again.',
};

function getPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This browser does not support location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, (err) => reject(new Error(ERRORS[err.code] || err.message)), {
      enableHighAccuracy: false,
      timeout: 12000,
      maximumAge: 10 * 60 * 1000,
    });
  });
}

/** Ask the browser for the position and turn it into {lat, lng, countryCode, countryName, city}. */
export async function locate() {
  const pos = await getPosition();
  const { latitude: lat, longitude: lng } = pos.coords;
  const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`;
  let place = {};
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (res.ok) place = await res.json();
  } catch {
    /* coordinates are still useful without a place name */
  }
  const result = {
    lat,
    lng,
    countryCode: place.countryCode || null,
    countryName: place.countryName || null,
    city: place.city || place.locality || place.principalSubdivision || null,
    at: Date.now(),
  };
  save('location', result);
  return result;
}

/** Last known location from an earlier visit (or null). */
export const lastLocation = () => load('location', null);

/** Region from the browser language, e.g. "en-KR" -> "KR". Used when no location is known. */
export function regionFromLanguage() {
  for (const lang of navigator.languages || [navigator.language]) {
    const m = /-([A-Z]{2})\b/.exec(lang || '');
    if (m) return m[1];
  }
  return null;
}
