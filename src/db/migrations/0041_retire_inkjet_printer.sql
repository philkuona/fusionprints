-- Retire the Epson SC-P5300 (inkjet): large/wall sizes are outsourced, so the
-- inkjet printer no longer prints anything in-house. Remove the seeded row so it
-- stops showing on the admin Printers page. The printer_type / target_printer_type
-- enums keep their 'inkjet' value for historical rows (no destructive change).
DELETE FROM "printers" WHERE "printer_type" = 'inkjet';
