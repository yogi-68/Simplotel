import { AvailabilityQuerySchema, type AvailabilityResponse, type HotelInfoResponse } from '@hotel/contracts';
import { Router } from 'express';
import { checkAvailability, listRoomTypes } from '../domain/availability/availability.service.js';
import { knowledgeBase } from '../domain/knowledge/kb.repository.js';
import { validateBody } from '../middleware/validate.js';

/**
 * Availability without the model in the loop.
 *
 * The booking form posts here directly. When a guest has already told us the
 * dates and party size through a date picker, involving a language model would
 * add latency, cost and a chance of misreading input that was never ambiguous.
 * This is the clearest expression of the split: deterministic questions get
 * deterministic answers.
 */
export function availabilityRouter(): Router {
  const router = Router();

  router.post('/availability', validateBody(AvailabilityQuerySchema), (req, res) => {
    // checkAvailability throws AppError.validation for broken business rules,
    // which Express 5 routes to the error handler as a 400.
    const availability = checkAvailability(req.body);
    const body: AvailabilityResponse = { ok: true, requestId: req.requestId, availability };
    res.json(body);
  });

  return router;
}

/**
 * Bootstrap data for the UI.
 *
 * The frontend hardcodes no hotel name, phone number or room list: swap the
 * knowledge base and inventory files and the entire interface re-labels itself.
 */
export function hotelRouter(): Router {
  const router = Router();

  router.get('/hotel', (req, res) => {
    const hotel = knowledgeBase.hotel();
    const body: HotelInfoResponse = {
      ok: true,
      requestId: req.requestId,
      hotel: {
        name: hotel.name,
        tagline: hotel.tagline,
        city: hotel.city,
        phone: hotel.phone,
        email: hotel.email,
        checkInTime: hotel.checkInTime,
        checkOutTime: hotel.checkOutTime,
      },
      roomTypes: listRoomTypes().map((room) => ({
        id: room.id,
        name: room.name,
        maxAdults: room.maxAdults,
        maxOccupancy: room.maxOccupancy,
        baseRate: room.baseRate,
      })),
      suggestedQuestions: knowledgeBase.suggestedQuestions(),
    };
    res.json(body);
  });

  return router;
}
