-- みんなのモデル: 登録者が作者か（1 = 自分で作った、0 = 他の人のモデル、NULL = 未申告）
-- 他の人のモデルは source_url / source_creator に元のモデルと作者を入れる（Civitai に同じファイルがあれば自動で入る）
ALTER TABLE user_models ADD COLUMN is_original INTEGER;
