-- safetensors の本体（ヘッダーを除いた部分）の sha256。A1111/Forge が PNGInfo の「Lora hashes」に書く値（先頭 12 文字）、
-- Civitai の AutoV3 と同じ。ピックアップモデルのお題で、アップロードした画像の LoRA を照合するのに使う（src/lib/user-models/addnet-hash.ts）
ALTER TABLE user_models ADD COLUMN addnet_hash TEXT;
