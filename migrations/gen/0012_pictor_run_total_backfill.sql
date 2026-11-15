-- 0012 を流したあと 1 回だけ: これまでの回から累計を埋める（何度流しても同じ値になる）
UPDATE pictor_run_scores
   SET total_score = COALESCE((SELECT SUM(p.score) FROM pictor_run_plays p WHERE p.user_id = pictor_run_scores.user_id), 0);
