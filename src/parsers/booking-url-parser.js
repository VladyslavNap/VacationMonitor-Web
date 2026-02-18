import { URL } from 'url';

/**
 * Booking.com URL Parser
 * Extracts search criteria from Booking.com search result URLs
 * 
 * Example URL:
 * https://www.booking.com/searchresults.html?dest_id=2647&dest_type=region&
 * checkin=2026-07-10&checkout=2026-07-20&group_adults=2&group_children=1&
 * age=7&no_rooms=1&selected_currency=EUR&min_price=300&review_score=80&
 * meal_plan=9&nflt=ht_id%3D204
 */

class BookingURLParser {
  /**
   * Parse a Booking.com search URL into structured criteria
   * @param {string} urlString - The Booking.com search URL
   * @returns {Object} Parsed search criteria
   */
  parse(urlString) {
    try {
      const url = new URL(urlString);
      
      // Validate it's a Booking.com URL
      if (!url.hostname.includes('booking.com')) {
        throw new Error('Invalid URL: Must be a Booking.com URL');
      }

      // Validate it's a search results page
      if (!url.pathname.includes('searchresults')) {
        throw new Error('Invalid URL: Must be a Booking.com search results URL');
      }

      const params = url.searchParams;

      // Extract required fields
      const destId = params.get('dest_id') || params.get('ss_dest_id');
      const destType = params.get('dest_type') || 'region';
      const checkin = params.get('checkin');
      const checkout = params.get('checkout');

      if (!destId) {
        throw new Error('Missing required field: destination ID (dest_id)');
      }

      if (!checkin || !checkout) {
        throw new Error('Missing required fields: check-in and check-out dates');
      }

      // Validate date format (YYYY-MM-DD)
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(checkin) || !dateRegex.test(checkout)) {
        throw new Error('Invalid date format. Expected YYYY-MM-DD');
      }

      // Validate dates are in the future and checkout is after checkin
      const checkinDate = new Date(checkin);
      const checkoutDate = new Date(checkout);
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      if (checkinDate < today) {
        throw new Error('Check-in date must be in the future');
      }

      if (checkoutDate <= checkinDate) {
        throw new Error('Check-out date must be after check-in date');
      }

      // Extract guest information
      const adults = parseInt(params.get('group_adults') || params.get('adults') || '2', 10);
      const children = parseInt(params.get('group_children') || params.get('children') || '0', 10);
      const rooms = parseInt(params.get('no_rooms') || params.get('rooms') || '1', 10);

      // Extract child ages (can be multiple)
      const childAges = [];
      if (children > 0) {
        for (let i = 0; i < children; i++) {
          const age = params.get(`age`) || params.get(`child_age_${i}`) || params.get(`age_${i}`);
          if (age) {
            childAges.push(parseInt(age, 10));
          }
        }
      }

      // Extract optional filters
      const currency = params.get('selected_currency') || 'EUR';
      const minPrice = params.get('min_price') ? parseInt(params.get('min_price'), 10) : null;
      const maxPrice = params.get('max_price') ? parseInt(params.get('max_price'), 10) : null;
      const reviewScore = params.get('review_score') ? parseInt(params.get('review_score'), 10) : null;
      const mealPlan = params.get('meal_plan') ? parseInt(params.get('meal_plan'), 10) : null;

      // Extract property type filter from nflt parameter
      // Example: nflt=ht_id%3D204 means hotel type ID = 204 (hotels only)
      let stayType = null;
      const nflt = params.get('nflt');
      if (nflt) {
        const htMatch = nflt.match(/ht_id(?:%3D|=)(\d+)/);
        if (htMatch) {
          stayType = parseInt(htMatch[1], 10);
        }
      }

      // Try to extract city/destination name
      // This might be in 'ss' (search string) parameter or we'll need to resolve it
      let cityName = params.get('ss') || params.get('dest_name') || null;
      if (cityName) {
        cityName = decodeURIComponent(cityName);
      }

      // Build criteria object matching the original config schema
      const criteria = {
        destination: destId,
        destinationType: destType,
        cityName: cityName,
        checkIn: checkin,
        checkOut: checkout,
        adults: adults,
        children: children,
        childAges: childAges,
        rooms: rooms,
        currency: currency
      };

      // Add optional fields only if present
      if (minPrice !== null) criteria.minPrice = minPrice;
      if (maxPrice !== null) criteria.maxPrice = maxPrice;
      if (reviewScore !== null) criteria.reviewScore = reviewScore;
      if (mealPlan !== null) criteria.mealPlan = mealPlan;
      if (stayType !== null) criteria.stayType = stayType;

      return {
        success: true,
        criteria: criteria,
        originalUrl: urlString
      };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        originalUrl: urlString
      };
    }
  }

  /**
   * Build a Booking.com search URL from criteria
   * @param {Object} criteria - Search criteria object
   * @returns {string} Booking.com search URL
   */
  buildUrl(criteria) {
    const baseUrl = 'https://www.booking.com/searchresults.html';
    const params = new URLSearchParams();

    // Required parameters
    params.append('dest_id', criteria.destination);
    params.append('dest_type', criteria.destinationType || 'region');
    params.append('checkin', criteria.checkIn);
    params.append('checkout', criteria.checkOut);
    params.append('group_adults', criteria.adults.toString());
    params.append('group_children', criteria.children.toString());
    params.append('no_rooms', criteria.rooms.toString());

    // Child ages
    if (criteria.children > 0 && criteria.childAges && criteria.childAges.length > 0) {
      criteria.childAges.forEach(age => {
        params.append('age', age.toString());
      });
    }

    // Optional parameters
    if (criteria.currency) {
      params.append('selected_currency', criteria.currency);
    }

    if (criteria.minPrice) {
      params.append('min_price', criteria.minPrice.toString());
    }

    if (criteria.maxPrice) {
      params.append('max_price', criteria.maxPrice.toString());
    }

    if (criteria.reviewScore) {
      params.append('review_score', criteria.reviewScore.toString());
    }

    if (criteria.mealPlan) {
      params.append('meal_plan', criteria.mealPlan.toString());
    }

    if (criteria.stayType) {
      params.append('nflt', `ht_id%3D${criteria.stayType}`);
    }

    return `${baseUrl}?${params.toString()}`;
  }

  /**
   * Validate search criteria object
   * @param {Object} criteria - Search criteria to validate
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  validate(criteria) {
    const errors = [];

    // Required fields
    if (!criteria.destination) {
      errors.push('Missing required field: destination');
    }

    if (!criteria.checkIn) {
      errors.push('Missing required field: checkIn');
    }

    if (!criteria.checkOut) {
      errors.push('Missing required field: checkOut');
    }

    // Validate dates if present
    if (criteria.checkIn && criteria.checkOut) {
      const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
      if (!dateRegex.test(criteria.checkIn)) {
        errors.push('Invalid checkIn date format. Expected YYYY-MM-DD');
      }
      if (!dateRegex.test(criteria.checkOut)) {
        errors.push('Invalid checkOut date format. Expected YYYY-MM-DD');
      }

      if (dateRegex.test(criteria.checkIn) && dateRegex.test(criteria.checkOut)) {
        const checkinDate = new Date(criteria.checkIn);
        const checkoutDate = new Date(criteria.checkOut);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (checkinDate < today) {
          errors.push('Check-in date must be in the future');
        }

        if (checkoutDate <= checkinDate) {
          errors.push('Check-out date must be after check-in date');
        }
      }
    }

    // Validate numeric fields
    if (criteria.adults !== undefined) {
      const adults = parseInt(criteria.adults, 10);
      if (isNaN(adults) || adults < 1 || adults > 30) {
        errors.push('Adults must be a number between 1 and 30');
      }
    }

    if (criteria.children !== undefined) {
      const children = parseInt(criteria.children, 10);
      if (isNaN(children) || children < 0 || children > 10) {
        errors.push('Children must be a number between 0 and 10');
      }
    }

    if (criteria.rooms !== undefined) {
      const rooms = parseInt(criteria.rooms, 10);
      if (isNaN(rooms) || rooms < 1 || rooms > 30) {
        errors.push('Rooms must be a number between 1 and 30');
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors
    };
  }

  /**
   * Get a human-readable summary of search criteria
   * @param {Object} criteria - Search criteria
   * @returns {string} Human-readable summary
   */
  getSummary(criteria) {
    const parts = [];

    if (criteria.cityName) {
      parts.push(criteria.cityName);
    } else {
      parts.push(`Destination ${criteria.destination}`);
    }

    parts.push(`${criteria.checkIn} to ${criteria.checkOut}`);
    parts.push(`${criteria.adults} adult${criteria.adults > 1 ? 's' : ''}`);

    if (criteria.children > 0) {
      parts.push(`${criteria.children} child${criteria.children > 1 ? 'ren' : ''}`);
    }

    parts.push(`${criteria.rooms} room${criteria.rooms > 1 ? 's' : ''}`);

    if (criteria.minPrice) {
      parts.push(`min ${criteria.currency || 'EUR'} ${criteria.minPrice}`);
    }

    if (criteria.reviewScore) {
      parts.push(`rating ${criteria.reviewScore / 10}+`);
    }

    return parts.join(', ');
  }
}

export default BookingURLParser;
