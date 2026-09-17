// @burgonomics/shared types

// Re-export commonly used types
export interface GeoCoordinates {
  lat: number;
  lng: number;
}

export interface DeviceInfo {
  device: string;
  browser: string;
  os: string;
}

export interface PorterAddress {
  apartment_address?: string;
  street_address1: string;
  city: string;
  state?: string;
  pincode?: string;
  country?: string;
  lat: number;
  lng: number;
  contact_details: {
    name: string;
    phone_number: string;
  };
}

export interface PorterBookingPayload {
  request_id: string;
  pickup_details: { address: PorterAddress };
  drop_details: { address: PorterAddress };
  delivery_instructions?: string;
  vehicle_type?: string;
}

export interface PorterBookingResponse {
  success: boolean;
  order_id: string;
  tracking_url: string;
  estimated_pickup_time?: number;
  driver_details?: {
    name: string;
    phone: string;
    vehicle_number: string;
  };
}

export interface PorterLiveQuoteRequest {
  pickupLat: number;
  pickupLng: number;
  dropLat: number;
  dropLng: number;
}

export interface PorterLiveQuoteResponse {
  distanceKm: number;
  fareRupees: number;
  pickupEtaMinutes: number;
  quoteId: string;
  source: "porter_api_live" | "porter_standard_rate_card";
}