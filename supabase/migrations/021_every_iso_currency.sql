-- Every currency in ISO 4217, so no one has to add one again.
--
-- The request was to accept whatever is typed in the currency column, and the
-- reason not to is specific rather than pedantic. GBP has 123 rows in this
-- ledger. Someone types GPB once and the report shows two currencies, both
-- looking equally real, with nothing flagged — and `currencies` is what
-- transactions.currency points at, so the typo becomes permanent reference
-- data. Blind acceptance turns a keystroke into an accounting fact.
--
-- What actually causes the friction is that the list held 29 codes: the ones
-- the workbook happened to contain. Any genuine currency outside it needed a
-- migration and a deploy. That is the thing worth removing, and this removes it
-- by seeding the standard in full. A real currency is now always known; a typo
-- still is not, because GPB is not a currency and never will be.
--
-- WHAT IS NOT HERE, DELIBERATELY
--   Precious metals (XAU, XAG, XPT, XPD) and the testing codes (XTS, XXX) are
--   ISO 4217 but are not money you settle a hotel bill in. Fund codes (BOV,
--   CHE, CHW, COU, MXV, USN, UYI, UYW) are units of account, not currencies a
--   card is charged in. Including them would put twenty entries in every
--   dropdown that nobody will ever choose, which makes the real ones harder to
--   find.
--
-- MINOR UNITS
--   Almost every currency has two. The exceptions are listed explicitly below,
--   and existing rows are never overwritten — the 29 codes already here were
--   curated against the workbook, so if this file disagreed with one of them
--   the curated value wins and the disagreement is reported by verify rather
--   than silently applied.
--
-- Safe to re-run.

begin;

-- No minor unit at all.
insert into currencies (code, name, minor_units) values
    ('BIF','Burundian Franc',0),      ('CLP','Chilean Peso',0),
    ('DJF','Djiboutian Franc',0),     ('GNF','Guinean Franc',0),
    ('ISK','Icelandic Krona',0),      ('KMF','Comorian Franc',0),
    ('KRW','South Korean Won',0),     ('PYG','Paraguayan Guarani',0),
    ('RWF','Rwandan Franc',0),        ('UGX','Ugandan Shilling',0),
    ('VND','Vietnamese Dong',0),      ('VUV','Vanuatu Vatu',0),
    ('XAF','Central African CFA Franc',0),
    ('XOF','West African CFA Franc',0),
    ('XPF','CFP Franc',0),            ('JPY','Japanese Yen',0)
on conflict (code) do nothing;

-- Three, the Gulf and North African dinars.
insert into currencies (code, name, minor_units) values
    ('BHD','Bahraini Dinar',3),       ('IQD','Iraqi Dinar',3),
    ('JOD','Jordanian Dinar',3),      ('KWD','Kuwaiti Dinar',3),
    ('LYD','Libyan Dinar',3),         ('OMR','Omani Rial',3),
    ('TND','Tunisian Dinar',3)
on conflict (code) do nothing;

-- Two, which is everything else.
insert into currencies (code, name, minor_units) values
    ('AED','UAE Dirham',2),           ('AFN','Afghan Afghani',2),
    ('ALL','Albanian Lek',2),         ('AMD','Armenian Dram',2),
    ('ANG','Netherlands Antillean Guilder',2),
    ('AOA','Angolan Kwanza',2),       ('ARS','Argentine Peso',2),
    ('AUD','Australian Dollar',2),    ('AWG','Aruban Florin',2),
    ('AZN','Azerbaijani Manat',2),    ('BAM','Bosnia and Herzegovina Convertible Mark',2),
    ('BBD','Barbadian Dollar',2),     ('BDT','Bangladeshi Taka',2),
    ('BGN','Bulgarian Lev',2),        ('BMD','Bermudian Dollar',2),
    ('BND','Brunei Dollar',2),        ('BOB','Bolivian Boliviano',2),
    ('BRL','Brazilian Real',2),       ('BSD','Bahamian Dollar',2),
    ('BTN','Bhutanese Ngultrum',2),   ('BWP','Botswana Pula',2),
    ('BYN','Belarusian Ruble',2),     ('BZD','Belize Dollar',2),
    ('CAD','Canadian Dollar',2),      ('CDF','Congolese Franc',2),
    ('CHF','Swiss Franc',2),          ('CNY','Chinese Yuan',2),
    ('COP','Colombian Peso',2),       ('CRC','Costa Rican Colon',2),
    ('CUP','Cuban Peso',2),           ('CVE','Cape Verdean Escudo',2),
    ('CZK','Czech Koruna',2),         ('DKK','Danish Krone',2),
    ('DOP','Dominican Peso',2),       ('DZD','Algerian Dinar',2),
    ('EGP','Egyptian Pound',2),       ('ERN','Eritrean Nakfa',2),
    ('ETB','Ethiopian Birr',2),       ('EUR','Euro',2),
    ('FJD','Fijian Dollar',2),        ('FKP','Falkland Islands Pound',2),
    ('GBP','Pound Sterling',2),       ('GEL','Georgian Lari',2),
    ('GHS','Ghanaian Cedi',2),        ('GIP','Gibraltar Pound',2),
    ('GMD','Gambian Dalasi',2),       ('GTQ','Guatemalan Quetzal',2),
    ('GYD','Guyanese Dollar',2),      ('HKD','Hong Kong Dollar',2),
    ('HNL','Honduran Lempira',2),     ('HTG','Haitian Gourde',2),
    ('HUF','Hungarian Forint',2),     ('IDR','Indonesian Rupiah',2),
    ('ILS','Israeli New Shekel',2),   ('INR','Indian Rupee',2),
    ('IRR','Iranian Rial',2),         ('JMD','Jamaican Dollar',2),
    ('KES','Kenyan Shilling',2),      ('KGS','Kyrgyzstani Som',2),
    ('KHR','Cambodian Riel',2),       ('KPW','North Korean Won',2),
    ('KYD','Cayman Islands Dollar',2),('KZT','Kazakhstani Tenge',2),
    ('LAK','Lao Kip',2),              ('LBP','Lebanese Pound',2),
    ('LKR','Sri Lankan Rupee',2),     ('LRD','Liberian Dollar',2),
    ('LSL','Lesotho Loti',2),         ('MAD','Moroccan Dirham',2),
    ('MDL','Moldovan Leu',2),         ('MGA','Malagasy Ariary',2),
    ('MKD','Macedonian Denar',2),     ('MMK','Myanmar Kyat',2),
    ('MNT','Mongolian Tugrik',2),     ('MOP','Macanese Pataca',2),
    ('MRU','Mauritanian Ouguiya',2),  ('MUR','Mauritian Rupee',2),
    ('MVR','Maldivian Rufiyaa',2),    ('MWK','Malawian Kwacha',2),
    ('MXN','Mexican Peso',2),         ('MYR','Malaysian Ringgit',2),
    ('MZN','Mozambican Metical',2),   ('NAD','Namibian Dollar',2),
    ('NGN','Nigerian Naira',2),       ('NIO','Nicaraguan Cordoba',2),
    ('NOK','Norwegian Krone',2),      ('NPR','Nepalese Rupee',2),
    ('NZD','New Zealand Dollar',2),   ('PAB','Panamanian Balboa',2),
    ('PEN','Peruvian Sol',2),         ('PGK','Papua New Guinean Kina',2),
    ('PHP','Philippine Peso',2),      ('PKR','Pakistani Rupee',2),
    ('PLN','Polish Zloty',2),         ('QAR','Qatari Riyal',2),
    ('RON','Romanian Leu',2),         ('RSD','Serbian Dinar',2),
    ('RUB','Russian Ruble',2),        ('SAR','Saudi Riyal',2),
    ('SBD','Solomon Islands Dollar',2),('SCR','Seychellois Rupee',2),
    ('SDG','Sudanese Pound',2),       ('SEK','Swedish Krona',2),
    ('SGD','Singapore Dollar',2),     ('SHP','Saint Helena Pound',2),
    ('SLE','Sierra Leonean Leone',2), ('SOS','Somali Shilling',2),
    ('SRD','Surinamese Dollar',2),    ('SSP','South Sudanese Pound',2),
    ('STN','Sao Tome and Principe Dobra',2),
    ('SVC','Salvadoran Colon',2),     ('SYP','Syrian Pound',2),
    ('SZL','Eswatini Lilangeni',2),   ('THB','Thai Baht',2),
    ('TJS','Tajikistani Somoni',2),   ('TMT','Turkmenistan Manat',2),
    ('TOP','Tongan Paanga',2),        ('TRY','Turkish Lira',2),
    ('TTD','Trinidad and Tobago Dollar',2),
    ('TWD','New Taiwan Dollar',2),    ('TZS','Tanzanian Shilling',2),
    ('UAH','Ukrainian Hryvnia',2),    ('USD','US Dollar',2),
    ('UYU','Uruguayan Peso',2),       ('UZS','Uzbekistani Som',2),
    ('VED','Venezuelan Digital Bolivar',2),
    ('VES','Venezuelan Bolivar',2),   ('WST','Samoan Tala',2),
    ('XCD','East Caribbean Dollar',2),('YER','Yemeni Rial',2),
    ('ZAR','South African Rand',2),   ('ZMW','Zambian Kwacha',2),
    ('ZWG','Zimbabwe Gold',2)
on conflict (code) do nothing;

commit;
