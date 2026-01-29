-- Migration: Add source column to documents table
-- Created: 2026-01-29
-- Description: Store booking source (Airbnb, Booking.com, Direct, etc.) for conditional invoice text

ALTER TABLE documents ADD COLUMN source TEXT;
