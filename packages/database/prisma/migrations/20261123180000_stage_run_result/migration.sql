-- Stored stage output, returned when a re-published event replays a finished run.
ALTER TABLE "stage_runs" ADD COLUMN "result" JSONB;
