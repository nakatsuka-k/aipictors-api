#!/usr/bin/env python3
"""Convert subscriptions.csv to D1-compatible SQL INSERT statements."""

import csv
import sys
from datetime import datetime, timezone


def parse_dt(val: str) -> int | None:
    """Convert 'YYYY-MM-DD HH:MM:SS' to unix epoch (UTC)."""
    if not val or val.upper() == "NULL":
        return None
    try:
        dt = datetime.strptime(val.strip(), "%Y-%m-%d %H:%M:%S")
        return int(dt.replace(tzinfo=timezone.utc).timestamp())
    except ValueError:
        return None


def escape(val: str) -> str:
    return val.replace("'", "''")


def to_sql_val(val: str | None) -> str:
    if val is None:
        return "NULL"
    return f"'{escape(val)}'"


def main(csv_path: str, sql_path: str, batch_size: int = 100) -> None:
    rows = []
    skipped = 0

    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            nanoid = row["nanoid"].strip()
            type_ = row["type"].strip()
            user_id = row["user_id"].strip()
            is_disabled = row["is_disabled"].strip()
            status = "canceled" if is_disabled == "1" else "active"

            created_at = parse_dt(row["created_at"])
            current_period_start = parse_dt(row["current_period_start"])
            current_period_end = parse_dt(row["current_period_end"])
            trial_start = parse_dt(row["trial_start"])
            trial_end = parse_dt(row["trial_end"])

            stripe_subscription_id = row["stripe_subscription_id"].strip()
            stripe_latest_invoice_id = row["stripe_latest_invoice_id"].strip() or None
            stripe_payment_intent_id = row["stripe_payment_intent_id"].strip() or None
            stripe_subscription_item_id = row["stripe_subscription_item_id"].strip() or None
            stripe_price_id = row["stripe_price_id"].strip() or None
            stripe_product_id = row["stripe_product_id"].strip() or None

            # Skip rows missing required fields
            if not nanoid or not stripe_subscription_id or created_at is None:
                skipped += 1
                continue

            rows.append((
                nanoid, user_id, type_, status, is_disabled,
                created_at, current_period_start, current_period_end,
                trial_start, trial_end,
                stripe_subscription_id, stripe_latest_invoice_id,
                stripe_payment_intent_id, stripe_subscription_item_id,
                stripe_price_id, stripe_product_id,
            ))

    print(f"Parsed {len(rows)} rows, skipped {skipped}", file=sys.stderr)

    with open(sql_path, "w", encoding="utf-8") as out:
        for i in range(0, len(rows), batch_size):
            batch = rows[i:i + batch_size]
            values = []
            for r in batch:
                (nanoid, user_id, type_, status, is_disabled,
                 created_at, current_period_start, current_period_end,
                 trial_start, trial_end,
                 stripe_subscription_id, stripe_latest_invoice_id,
                 stripe_payment_intent_id, stripe_subscription_item_id,
                 stripe_price_id, stripe_product_id) = r

                v = (
                    f"({to_sql_val(nanoid)},{to_sql_val(user_id)},{to_sql_val(type_)},"
                    f"{to_sql_val(status)},{is_disabled},"
                    f"{created_at},{current_period_start if current_period_start is not None else 'NULL'},"
                    f"{current_period_end if current_period_end is not None else 'NULL'},"
                    f"{trial_start if trial_start is not None else 'NULL'},"
                    f"{trial_end if trial_end is not None else 'NULL'},"
                    f"{to_sql_val(stripe_subscription_id)},"
                    f"{to_sql_val(stripe_latest_invoice_id) if stripe_latest_invoice_id else 'NULL'},"
                    f"{to_sql_val(stripe_payment_intent_id) if stripe_payment_intent_id else 'NULL'},"
                    f"{to_sql_val(stripe_subscription_item_id) if stripe_subscription_item_id else 'NULL'},"
                    f"{to_sql_val(stripe_price_id) if stripe_price_id else 'NULL'},"
                    f"{to_sql_val(stripe_product_id) if stripe_product_id else 'NULL'})"
                )
                values.append(v)

            stmt = (
                "INSERT OR IGNORE INTO subscriptions("
                "nanoid,user_id,type,status,is_disabled,"
                "created_at,current_period_start,current_period_end,"
                "trial_start,trial_end,"
                "stripe_subscription_id,stripe_latest_invoice_id,"
                "stripe_payment_intent_id,stripe_subscription_item_id,"
                "stripe_price_id,stripe_product_id"
                ") VALUES\n" + ",\n".join(values) + ";\n"
            )
            out.write(stmt)

    print(f"Written to {sql_path}", file=sys.stderr)


if __name__ == "__main__":
    csv_path = sys.argv[1] if len(sys.argv) > 1 else "/Users/nakatsuka-k/Downloads/subscriptions.csv"
    sql_path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/subscriptions-import.sql"
    main(csv_path, sql_path)
