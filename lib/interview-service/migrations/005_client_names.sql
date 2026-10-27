-- Client accounts (e.g. recooty, recooty_dev, recooty_staging) are addressed by name in operator commands and usage reports.
CREATE UNIQUE INDEX service_accounts_name_unique ON service_accounts (lower(name));
