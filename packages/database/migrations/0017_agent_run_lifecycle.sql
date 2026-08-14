ALTER TYPE "agent_run_status" ADD VALUE IF NOT EXISTS 'running';
--> statement-breakpoint
ALTER TYPE "agent_run_status" ADD VALUE IF NOT EXISTS 'stopped';
