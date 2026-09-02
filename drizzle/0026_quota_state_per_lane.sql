ALTER TABLE `quota_state` RENAME COLUMN `id` TO `lane`;--> statement-breakpoint
-- The one pre-existing row was keyed `fleet`, and it can only ever have been
-- written by a subscription-authenticated pass: the unified-window machinery is
-- subscription-only, so a deployment running on an API key never wrote a row at
-- all. Re-attributing it is therefore a statement of fact, not a guess. `OR
-- REPLACE` because the destination is a primary key and this is not worth
-- failing a boot over -- the row is one latest-wins observation that the next
-- turn re-writes.
UPDATE OR REPLACE `quota_state` SET `lane` = 'claude-subscription' WHERE `lane` = 'fleet';
