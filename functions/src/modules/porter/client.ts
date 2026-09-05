/**
 * Porter Enterprise Open API v1 payload shapes (verified against the live
 * integration in porter.service.ts). Types only — the dead client class was
 * removed; all live calls go through porter.service.ts direct fetch.
 */
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

export interface PorterAddress {
  apartment_address?: string;
  /** Porter API field is street_address1 (not street_address). */
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
  pickup_details: {
    address: PorterAddress;
  };
  drop_details: {
    address: PorterAddress;
  };
  /** Structured delivery instructions (a free-text top-level comment is ignored). */
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
