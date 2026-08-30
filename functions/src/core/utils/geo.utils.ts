/**
 * Standard Haversine distance calculation and delivery rate card utilities.
 */

export interface GeoCoordinates {
  lat: number;
  lng: number;
}

/**
 * Calculates great-circle distance between two GPS coordinates in kilometers.
 */
export function calculateHaversineDistanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371; // Earth's mean radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const rawDist = R * c;
  return Math.max(1.0, Math.round(rawDist * 10) / 10);
}

/**
 * Calculates standard Porter 2-Wheeler fare:
 * Base fare ₹40 for up to 2 km, + ₹10/km thereafter.
 */
export function calculatePorterFare(distanceKm: number): number {
  const dist = Math.max(1.0, distanceKm);
  if (dist <= 2.0) {
    return 40;
  }
  return Math.round(40 + (dist - 2.0) * 10);
}

/**
 * Estimates pickup & delivery ETA in minutes.
 */
export function estimatePickupMinutes(): number {
  return 8;
}
