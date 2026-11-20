-- Setup wizard + global categories (AI-SOZLASH.md, slice 1).
--
-- Idempotent; additive only — the code still serving during the rollout never
-- reads any of it, and dropping NOT NULL on categories.name breaks no reader
-- of an existing row (every existing row keeps its name).
--
--   global_categories   the shared category list (4 languages), managed only
--                       from the platform console; hidden, never deleted.
--   store_directions    lines of trade = an ordered set of global category
--                       keys; the wizard's "Nima sotasiz?".
--   categories.global_key  a shop row that links a global category; its name
--                       is NULL and is read from global_categories in the
--                       viewer's language. Row id is 'g-<key>'.
--   businesses.directions / direction_text / setup_status / setup_step
--                       what the owner answered and how far the wizard got.
--
-- The seed below is the starting list (12 directions, 96 categories); the
-- console edits it from here on. ON CONFLICT DO NOTHING so a re-run never
-- overwrites console edits.

CREATE TABLE IF NOT EXISTS "global_categories" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "name_uz" varchar(120) NOT NULL,
  "name_uzc" varchar(120) NOT NULL,
  "name_ru" varchar(120) NOT NULL,
  "name_en" varchar(120) NOT NULL,
  "image" varchar(500),
  "is_hidden" boolean DEFAULT false NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "store_directions" (
  "key" varchar(64) PRIMARY KEY NOT NULL,
  "name_uz" varchar(120) NOT NULL,
  "name_uzc" varchar(120) NOT NULL,
  "name_ru" varchar(120) NOT NULL,
  "name_en" varchar(120) NOT NULL,
  "category_keys" text[] DEFAULT '{}'::text[] NOT NULL,
  "is_hidden" boolean DEFAULT false NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

ALTER TABLE "categories" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "categories" ADD COLUMN IF NOT EXISTS "global_key" varchar(64);

DO $$ BEGIN
 ALTER TABLE "categories" ADD CONSTRAINT "categories_global_key_global_categories_key_fk" FOREIGN KEY ("global_key") REFERENCES "public"."global_categories"("key") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "categories_business_global_key_uq"
  ON "categories" USING btree ("business_id", "global_key")
  WHERE global_key IS NOT NULL;

ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "directions" text[];
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "direction_text" varchar(200);
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "setup_status" varchar(8);
ALTER TABLE "businesses" ADD COLUMN IF NOT EXISTS "setup_step" varchar(16);

-- Shops that already have a category or a product are past setup: the wizard
-- must never open over a running catalogue. Mark them 'skipped' (the console
-- tells these apart by created_at, which predates this file).
UPDATE "businesses" b SET "setup_status" = 'skipped'
WHERE b."setup_status" IS NULL
  AND (EXISTS (SELECT 1 FROM "categories" c WHERE c."business_id" = b."id" AND NOT c."is_deleted")
    OR EXISTS (SELECT 1 FROM "products" p WHERE p."business_id" = b."id"));

INSERT INTO "global_categories" ("key", "name_uz", "name_uzc", "name_ru", "name_en", "sort") VALUES
  ('dairy', 'Sut mahsulotlari', 'Сут маҳсулотлари', 'Молочные продукты', 'Dairy', 0),
  ('bread', 'Non va pishiriqlar', 'Нон ва пишириқлар', 'Хлеб и выпечка', 'Bread and pastries', 10),
  ('meat', 'Go''sht va kolbasa', 'Гўшт ва колбаса', 'Мясо и колбасы', 'Meat and sausages', 20),
  ('fruits_vegetables', 'Meva va sabzavotlar', 'Мева ва сабзавотлар', 'Фрукты и овощи', 'Fruit and vegetables', 30),
  ('grains', 'Don, yorma va makaron', 'Дон, ёрма ва макарон', 'Крупы и макароны', 'Grains and pasta', 40),
  ('oil_spices', 'Yog'' va ziravorlar', 'Ёғ ва зираворлар', 'Масло и специи', 'Oil and spices', 50),
  ('sweets', 'Shirinliklar', 'Ширинликлар', 'Сладости', 'Sweets', 60),
  ('tea_coffee', 'Choy va qahva', 'Чой ва қаҳва', 'Чай и кофе', 'Tea and coffee', 70),
  ('drinks', 'Ichimliklar', 'Ичимликлар', 'Напитки', 'Drinks', 80),
  ('canned', 'Konservalar', 'Консервалар', 'Консервы', 'Canned food', 90),
  ('frozen', 'Muzlatilgan mahsulotlar', 'Музлатилган маҳсулотлар', 'Замороженные продукты', 'Frozen food', 100),
  ('snacks', 'Chips va gazaklar', 'Чипс ва газаклар', 'Снеки', 'Snacks', 110),
  ('baby_food', 'Bolalar ovqati', 'Болалар овқати', 'Детское питание', 'Baby food', 120),
  ('household_chemicals', 'Maishiy kimyo', 'Маиший кимё', 'Бытовая химия', 'Household chemicals', 130),
  ('hygiene', 'Gigiyena', 'Гигиена', 'Гигиена', 'Hygiene', 140),
  ('womens_clothing', 'Ayollar kiyimi', 'Аёллар кийими', 'Женская одежда', 'Women''s clothing', 150),
  ('mens_clothing', 'Erkaklar kiyimi', 'Эркаклар кийими', 'Мужская одежда', 'Men''s clothing', 160),
  ('kids_clothing', 'Bolalar kiyimi', 'Болалар кийими', 'Детская одежда', 'Kids'' clothing', 170),
  ('outerwear', 'Ustki kiyim', 'Устки кийим', 'Верхняя одежда', 'Outerwear', 180),
  ('underwear', 'Ichki kiyim', 'Ички кийим', 'Нижнее бельё', 'Underwear', 190),
  ('sportswear', 'Sport kiyimi', 'Спорт кийими', 'Спортивная одежда', 'Sportswear', 200),
  ('headwear', 'Bosh kiyimlar', 'Бош кийимлар', 'Головные уборы', 'Headwear', 210),
  ('socks', 'Paypoq va kolgotkalar', 'Пайпоқ ва колготкалар', 'Носки и колготки', 'Socks and tights', 220),
  ('accessories', 'Aksessuarlar', 'Аксессуарлар', 'Аксессуары', 'Accessories', 230),
  ('bags', 'Sumkalar', 'Сумкалар', 'Сумки', 'Bags', 240),
  ('womens_shoes', 'Ayollar poyabzali', 'Аёллар пойабзали', 'Женская обувь', 'Women''s shoes', 250),
  ('mens_shoes', 'Erkaklar poyabzali', 'Эркаклар пойабзали', 'Мужская обувь', 'Men''s shoes', 260),
  ('kids_shoes', 'Bolalar poyabzali', 'Болалар пойабзали', 'Детская обувь', 'Kids'' shoes', 270),
  ('sneakers', 'Krossovkalar', 'Кроссовкалар', 'Кроссовки', 'Sneakers', 280),
  ('slippers', 'Shippaklar', 'Шиппаклар', 'Тапочки и шлёпанцы', 'Slippers', 290),
  ('shoe_care', 'Poyabzal parvarishi', 'Пойабзал парвариши', 'Уход за обувью', 'Shoe care', 300),
  ('cleaning_tools', 'Tozalash jihozlari', 'Тозалаш жиҳозлари', 'Инвентарь для уборки', 'Cleaning tools', 310),
  ('kitchenware', 'Oshxona anjomlari', 'Ошхона анжомлари', 'Посуда и кухня', 'Kitchenware', 320),
  ('home_textiles', 'Uy tekstili', 'Уй текстили', 'Домашний текстиль', 'Home textiles', 330),
  ('storage', 'Idish va konteynerlar', 'Идиш ва контейнерлар', 'Контейнеры для хранения', 'Storage containers', 340),
  ('paper_goods', 'Qog''oz mahsulotlari', 'Қоғоз маҳсулотлари', 'Бумажная продукция', 'Paper goods', 350),
  ('small_tools', 'Mayda asboblar', 'Майда асбоблар', 'Мелкий инструмент', 'Small tools', 360),
  ('bulbs_electrics', 'Lampochka va elektr', 'Лампочка ва электр', 'Лампочки и электрика', 'Bulbs and electrics', 370),
  ('garden', 'Bog'' va hovli', 'Боғ ва ҳовли', 'Сад и двор', 'Garden', 380),
  ('home_decor', 'Uy bezaklari', 'Уй безаклари', 'Декор для дома', 'Home decor', 390),
  ('face_care', 'Yuz parvarishi', 'Юз парвариши', 'Уход за лицом', 'Face care', 400),
  ('body_care', 'Tana parvarishi', 'Тана парвариши', 'Уход за телом', 'Body care', 410),
  ('hair_care', 'Soch parvarishi', 'Соч парвариши', 'Уход за волосами', 'Hair care', 420),
  ('makeup', 'Dekorativ kosmetika', 'Декоратив косметика', 'Декоративная косметика', 'Makeup', 430),
  ('perfume', 'Atirlar', 'Атирлар', 'Парфюмерия', 'Perfume', 440),
  ('nail_care', 'Tirnoq parvarishi', 'Тирноқ парвариши', 'Уход за ногтями', 'Nail care', 450),
  ('mens_care', 'Erkaklar uchun', 'Эркаклар учун', 'Для мужчин', 'Men''s care', 460),
  ('cement_mixes', 'Sement va quruq aralashmalar', 'Цемент ва қуруқ аралашмалар', 'Цемент и сухие смеси', 'Cement and dry mixes', 470),
  ('paints', 'Bo''yoqlar', 'Бўёқлар', 'Краски', 'Paints', 480),
  ('plumbing', 'Santexnika', 'Сантехника', 'Сантехника', 'Plumbing', 490),
  ('electrical', 'Elektr mollari', 'Электр моллари', 'Электротовары', 'Electrical supplies', 500),
  ('tools', 'Asboblar', 'Асбоблар', 'Инструменты', 'Tools', 510),
  ('fasteners', 'Mahkamlagichlar', 'Маҳкамлагичлар', 'Крепёж', 'Fasteners', 520),
  ('tiles_flooring', 'Kafel va pol qoplamalari', 'Кафел ва пол қопламалари', 'Плитка и напольные покрытия', 'Tiles and flooring', 530),
  ('wood_boards', 'Yog''och va plitalar', 'Ёғоч ва плиталар', 'Дерево и плиты', 'Wood and boards', 540),
  ('doors_windows', 'Eshik va derazalar', 'Эшик ва деразалар', 'Двери и окна', 'Doors and windows', 550),
  ('roofing', 'Tom yopish materiallari', 'Том ёпиш материаллари', 'Кровля', 'Roofing', 560),
  ('tv_audio', 'Televizor va audio', 'Телевизор ва аудио', 'ТВ и аудио', 'TV and audio', 570),
  ('large_appliances', 'Yirik maishiy texnika', 'Йирик маиший техника', 'Крупная бытовая техника', 'Large appliances', 580),
  ('small_appliances', 'Kichik maishiy texnika', 'Кичик маиший техника', 'Мелкая бытовая техника', 'Small appliances', 590),
  ('computers', 'Kompyuter va noutbuklar', 'Компьютер ва ноутбуклар', 'Компьютеры и ноутбуки', 'Computers and laptops', 600),
  ('climate', 'Iqlim texnikasi', 'Иқлим техникаси', 'Климатическая техника', 'Climate control', 610),
  ('cables_chargers', 'Kabel va quvvatlagichlar', 'Кабел ва қувватлагичлар', 'Кабели и зарядки', 'Cables and chargers', 620),
  ('batteries', 'Batareyalar', 'Батареялар', 'Батарейки', 'Batteries', 630),
  ('smartphones', 'Smartfonlar', 'Смартфонлар', 'Смартфоны', 'Smartphones', 640),
  ('basic_phones', 'Oddiy telefonlar', 'Оддий телефонлар', 'Кнопочные телефоны', 'Basic phones', 650),
  ('phone_cases', 'G''ilof va himoya oynalari', 'Ғилоф ва ҳимоя ойналари', 'Чехлы и защитные стёкла', 'Cases and screen protectors', 660),
  ('headphones', 'Quloqchinlar', 'Қулоқчинлар', 'Наушники', 'Headphones', 670),
  ('powerbanks', 'Powerbanklar', 'Повербанклар', 'Пауэрбанки', 'Power banks', 680),
  ('smartwatches', 'Aqlli soatlar', 'Ақлли соатлар', 'Смарт-часы', 'Smartwatches', 690),
  ('memory_cards', 'Xotira kartalari', 'Хотира карталари', 'Карты памяти', 'Memory cards', 700),
  ('notebooks', 'Daftar va bloknotlar', 'Дафтар ва блокнотлар', 'Тетради и блокноты', 'Notebooks', 710),
  ('pens', 'Ruchka va qalamlar', 'Ручка ва қаламлар', 'Ручки и карандаши', 'Pens and pencils', 720),
  ('office_paper', 'Qog''oz va papkalar', 'Қоғоз ва папкалар', 'Бумага и папки', 'Paper and folders', 730),
  ('school_supplies', 'Maktab anjomlari', 'Мактаб анжомлари', 'Школьные принадлежности', 'School supplies', 740),
  ('art_supplies', 'Ijodkorlik anjomlari', 'Ижодкорлик анжомлари', 'Товары для творчества', 'Art supplies', 750),
  ('books', 'Kitoblar', 'Китоблар', 'Книги', 'Books', 760),
  ('backpacks', 'Ryukzaklar', 'Рюкзаклар', 'Рюкзаки', 'Backpacks', 770),
  ('gift_wrapping', 'Sovg''a o''ramlari', 'Совға ўрамлари', 'Подарочная упаковка', 'Gift wrapping', 780),
  ('toys', 'O''yinchoqlar', 'Ўйинчоқлар', 'Игрушки', 'Toys', 790),
  ('diapers', 'Tagliklar', 'Тагликлар', 'Подгузники', 'Diapers', 800),
  ('baby_care', 'Chaqaloq parvarishi', 'Чақалоқ парвариши', 'Уход за малышом', 'Baby care', 810),
  ('strollers', 'Aravacha va avtokreslolar', 'Аравача ва автокреслолар', 'Коляски и автокресла', 'Strollers and car seats', 820),
  ('engine_oils', 'Motor moylari', 'Мотор мойлари', 'Моторные масла', 'Engine oils', 830),
  ('filters', 'Filtrlar', 'Филтрлар', 'Фильтры', 'Filters', 840),
  ('brakes', 'Tormoz qismlari', 'Тормоз қисмлари', 'Тормозная система', 'Brake parts', 850),
  ('auto_electrics', 'Avto elektrika', 'Авто электрика', 'Автоэлектрика', 'Auto electrics', 860),
  ('car_batteries', 'Akkumulyatorlar', 'Аккумуляторлар', 'Аккумуляторы', 'Car batteries', 870),
  ('tires', 'Shina va disklar', 'Шина ва дисклар', 'Шины и диски', 'Tires and wheels', 880),
  ('suspension', 'Yurish qismi', 'Юриш қисми', 'Ходовая часть', 'Suspension', 890),
  ('car_chemicals', 'Avtokimyo', 'Автокимё', 'Автохимия', 'Car chemicals', 900),
  ('car_accessories', 'Avto aksessuarlar', 'Авто аксессуарлар', 'Автоаксессуары', 'Car accessories', 910),
  ('medicines', 'Dori vositalari', 'Дори воситалари', 'Лекарства', 'Medicines', 920),
  ('vitamins', 'Vitaminlar', 'Витаминлар', 'Витамины', 'Vitamins', 930),
  ('medical_supplies', 'Tibbiy buyumlar', 'Тиббий буюмлар', 'Медицинские изделия', 'Medical supplies', 940),
  ('medical_devices', 'Tibbiy asboblar', 'Тиббий асбоблар', 'Медтехника', 'Medical devices', 950)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "store_directions" ("key", "name_uz", "name_uzc", "name_ru", "name_en", "category_keys", "sort") VALUES
  ('grocery', 'Oziq-ovqat', 'Озиқ-овқат', 'Продукты питания', 'Groceries', ARRAY['dairy', 'bread', 'meat', 'fruits_vegetables', 'grains', 'oil_spices', 'sweets', 'tea_coffee', 'drinks', 'canned', 'frozen', 'snacks', 'baby_food', 'household_chemicals', 'hygiene']::text[], 0),
  ('clothing', 'Kiyim-kechak', 'Кийим-кечак', 'Одежда', 'Clothing', ARRAY['womens_clothing', 'mens_clothing', 'kids_clothing', 'outerwear', 'underwear', 'sportswear', 'headwear', 'socks', 'accessories', 'bags']::text[], 10),
  ('shoes', 'Poyabzal', 'Пойабзал', 'Обувь', 'Shoes', ARRAY['womens_shoes', 'mens_shoes', 'kids_shoes', 'sneakers', 'slippers', 'shoe_care', 'socks', 'bags']::text[], 20),
  ('household', 'Xo''jalik mollari', 'Хўжалик моллари', 'Хозтовары', 'Household goods', ARRAY['household_chemicals', 'cleaning_tools', 'kitchenware', 'home_textiles', 'storage', 'hygiene', 'paper_goods', 'small_tools', 'bulbs_electrics', 'garden', 'home_decor']::text[], 30),
  ('cosmetics', 'Kosmetika va parfyumeriya', 'Косметика ва парфюмерия', 'Косметика и парфюмерия', 'Cosmetics and perfume', ARRAY['face_care', 'body_care', 'hair_care', 'makeup', 'perfume', 'nail_care', 'mens_care', 'hygiene']::text[], 40),
  ('building', 'Qurilish mollari', 'Қурилиш моллари', 'Стройматериалы', 'Building materials', ARRAY['cement_mixes', 'paints', 'plumbing', 'electrical', 'tools', 'fasteners', 'tiles_flooring', 'wood_boards', 'doors_windows', 'roofing', 'bulbs_electrics']::text[], 50),
  ('electronics', 'Elektronika va maishiy texnika', 'Электроника ва маиший техника', 'Электроника и бытовая техника', 'Electronics and appliances', ARRAY['tv_audio', 'large_appliances', 'small_appliances', 'computers', 'climate', 'cables_chargers', 'batteries', 'bulbs_electrics']::text[], 60),
  ('phones', 'Telefon va aksessuarlar', 'Телефон ва аксессуарлар', 'Телефоны и аксессуары', 'Phones and accessories', ARRAY['smartphones', 'basic_phones', 'phone_cases', 'headphones', 'cables_chargers', 'powerbanks', 'smartwatches', 'memory_cards']::text[], 70),
  ('stationery', 'Kanselyariya va kitoblar', 'Канцелярия ва китоблар', 'Канцтовары и книги', 'Stationery and books', ARRAY['notebooks', 'pens', 'office_paper', 'school_supplies', 'art_supplies', 'books', 'backpacks', 'gift_wrapping']::text[], 80),
  ('kids', 'Bolalar mollari va o''yinchoqlar', 'Болалар моллари ва ўйинчоқлар', 'Детские товары и игрушки', 'Kids'' goods and toys', ARRAY['toys', 'kids_clothing', 'kids_shoes', 'diapers', 'baby_food', 'baby_care', 'strollers', 'school_supplies']::text[], 90),
  ('auto', 'Avto ehtiyot qismlar', 'Авто эҳтиёт қисмлар', 'Автозапчасти', 'Car parts', ARRAY['engine_oils', 'filters', 'brakes', 'auto_electrics', 'car_batteries', 'tires', 'suspension', 'car_chemicals', 'car_accessories']::text[], 100),
  ('pharmacy', 'Dorixona', 'Дорихона', 'Аптека', 'Pharmacy', ARRAY['medicines', 'vitamins', 'medical_supplies', 'medical_devices', 'hygiene', 'baby_care', 'face_care']::text[], 110)
ON CONFLICT ("key") DO NOTHING;
