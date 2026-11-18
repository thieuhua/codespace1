-- Apply ONCE after v5, before deploying the phase-4 Worker.
ALTER TABLE tasks ADD COLUMN question_count INTEGER NOT NULL DEFAULT 0 CHECK(question_count BETWEEN 0 AND 5);
-- Only committed question reservations spend quota; overwrites/cancelled runs do not.
CREATE TRIGGER outbound_question_count AFTER INSERT ON outbound_mails WHEN NEW.kind='question' BEGIN
  UPDATE tasks SET question_count=question_count+1 WHERE id=NEW.task_id;
END;
