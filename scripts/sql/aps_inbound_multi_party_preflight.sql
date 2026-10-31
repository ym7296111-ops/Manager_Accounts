-- =============================================================================
-- aps_inbound_multi_party_preflight.sql
-- تقرير أرقام قبل/بعد ترحيل 20261119000000_aps_inbound_multi_party_columns.sql
--
-- ⚠ هذا الملف **ليس ترحيلًا**: مكانه scripts/sql/ ولا يجوز وضعه في
--   supabase/migrations/. كل الاستعلامات **قراءة فقط** (select فقط)، فيجوز
--   تشغيله على الإنتاج بأمان قبل الترحيل وبعده.
--
-- الاستخدام:
--   1) قبل الترحيل:  شغّل الملف كاملًا في محرّر SQL واحفظ المخرجات (BEFORE).
--   2) طبّق الترحيل.
--   3) بعدها:       شغّل نفس الملف مرة أخرى (AFTER) وقارن.
--
-- الملف يكتشف بنفسه هل أعمدة الجهة موجودة، ويطبع العناوين «قبل» أو «بعد»،
-- فالمقارنة بين تقريرين لا تحتاج تعديلًا يدويًا.
--
-- القسم 4 هو بوابة القرار: إذا لم يكن كل صفوفه أصفارًا فلا تُطبّق الترحيل.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0) بصمة الأرقام — يجب أن تتطابق حرفيًا بين BEFORE و AFTER
-- -----------------------------------------------------------------------------
select '0. money digest' as section,
       (select count(*) from public.letters)                          as letters,
       (select count(*) from public.letter_lines)                     as lines,
       (select count(*) from public.letters where status = 'draft')   as drafts,
       (select count(*) from public.letters where status = 'approved') as approved,
       (select coalesce(sum(amount), 0) from public.letter_lines)     as lines_amount,
       (select coalesce(sum(source_total), 0) from public.letters)    as header_source,
       (select coalesce(sum(destination_total), 0) from public.letters) as header_destination,
       -- A single checksum of the whole money picture: any change shows up here.
       (select md5(string_agg(
                 letter.id::text || ':' || letter.source_total::text || ':' ||
                 letter.destination_total::text, ',' order by letter.id))
          from public.letters as letter)                             as headers_checksum,
       (select md5(string_agg(
                 line.letter_id::text || ':' || line.line_number::text || ':' ||
                 line.amount::text, ',' order by line.letter_id, line.line_number))
          from public.letter_lines as line)                          as lines_checksum;

-- -----------------------------------------------------------------------------
-- 1) توزيع الخطابات — لماذا يهم: كل نوع له مسار مختلف في التعبئة الرجعية
-- -----------------------------------------------------------------------------
select '1. letters by type / status' as section,
       letter.letter_type,
       letter.status,
       count(*)                                          as letters,
       (select count(*)
          from public.letter_lines as line
         where line.letter_id in (
           select inner_letter.id
             from public.letters as inner_letter
            where inner_letter.letter_type = letter.letter_type
              and inner_letter.status = letter.status))
                                                         as lines
  from public.letters as letter
 group by letter.letter_type, letter.status
 order by letter.letter_type, letter.status;

-- -----------------------------------------------------------------------------
-- 2) هل توجد سطور وارد بلا جهة على رأسها؟ (يجب أن يكون صفرًا قبل الترحيل)
-- -----------------------------------------------------------------------------
-- القيد letters_counterparty_matches_type يمنع هذا في الظروف العادية، لكن صفًا
-- كُتب قبل تشغيل المشغّل قد يكون استثناءً. الصفوف هنا **لا يمكن تعبئتها**،
-- وأي رقم غير صفري يجب أن يُعالج بشريًا قبل الترحيل.
select '2. inbound lines whose header has no party' as section,
       count(*) as lines_to_fix
  from public.letter_lines as line
  join public.letters as letter on letter.id = line.letter_id
 where letter.letter_type = 'inbound'
   and letter.party_id is null;

-- -----------------------------------------------------------------------------
-- 3) الخطابات التي لا تحمل لقطة اسم جهة (سيُستخدم الاسم الحالي بدلًا منها)
-- -----------------------------------------------------------------------------
-- الترحيل يفضّل لقطة الرأس دائمًا. هذه القائمة تُظهر الحالات التي ستُعبّأ من
-- جدول الجهات لأن الرأس نفسه بلا لقطة — معلوماتية فقط، لا تمنع الترحيل.
select '3. inbound letters with a missing header snapshot' as section,
       letter.id,
       letter.letter_number,
       letter.party_id is not null as has_party,
       letter.counterparty_code is null as code_missing,
       letter.counterparty_name is null as name_missing
  from public.letters as letter
 where letter.letter_type = 'inbound'
   and (letter.counterparty_code is null or letter.counterparty_name is null)
 order by letter.letter_date desc
 limit 50;

-- -----------------------------------------------------------------------------
-- 4) بوابة القرار — تكرارات (مخزن + تصنيف) داخل خطاب وارد واحد
-- -----------------------------------------------------------------------------
-- هذه هي الحالة التي كانت ستُفشل أي فهرس فريد على (مخزن، تصنيف): خطابات
-- **معتمدة ومجمّدة** تحمل نفس الزوج مرتين، ولا يجوز تعديلها.
-- الرقم هنا **معلوماتي ولا يمنع الترحيل** (الترحيل لا ينشئ فهرسًا فريدًا)،
-- لكن يجب أن يُقرأ: إن ظهرت صفوف فهي تُثبت أن قرار «الفحص في المشغّل» صحيح.
select '4. duplicate (warehouse, classification) within one inbound letter' as section,
       letter.id                as letter_id,
       letter.letter_number,
       letter.status,
       line.warehouse_id,
       line.classification_id,
       count(*)                 as repeated_lines
  from public.letter_lines as line
  join public.letters as letter on letter.id = line.letter_id
 where letter.letter_type = 'inbound'
 group by letter.id, letter.letter_number, letter.status,
          line.warehouse_id, line.classification_id
having count(*) > 1
 order by letter.letter_date desc, letter.letter_number
 limit 50;

-- -----------------------------------------------------------------------------
-- 5) جهات متوقفة/محذوفة مستخدمة في خطابات — سياق فقط
-- -----------------------------------------------------------------------------
select '5. deactivated parties used by letters' as section,
       party.code,
       party.name,
       party.is_active,
       count(letter.id) as letters
  from public.parties as party
  join public.letters as letter on letter.party_id = party.id
 where party.is_active = false
 group by party.code, party.name, party.is_active
 order by party.code;

-- -----------------------------------------------------------------------------
-- 6) حالة الترحيل — قبل / بعد (يكتشف نفسه)
-- -----------------------------------------------------------------------------
do $preflight$
declare
  v_has_column boolean;
  v_label      text;
  v_missing    integer;
  v_stray      integer;
  v_counter    integer;
  v_inbound    integer;
  v_treedrafts integer;
begin
  select exists (
           select 1
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'letter_lines'
              and column_name = 'party_id'
         )
    into v_has_column;

  if v_has_column then
    v_label := 'AFTER';
  else
    v_label := 'BEFORE';
    raise notice 'aps multi-party [%]: letter_lines.party_id does not exist yet — this is the pre-migration picture', v_label;
    return;
  end if;

  select count(*)
    into v_missing
    from public.letter_lines as line
    join public.letters as letter on letter.id = line.letter_id
   where letter.letter_type = 'inbound'
     and (line.party_id is null or line.party_code is null or line.party_name is null);

  select count(*)
    into v_stray
    from public.letter_lines as line
    join public.letters as letter on letter.id = line.letter_id
   where letter.letter_type <> 'inbound'
     and (line.party_id is not null or line.party_code is not null or line.party_name is not null);

  select count(*)
    into v_counter
    from public.letters as letter
   where letter.party_count is distinct from coalesce(
           (select count(distinct line.party_id)
              from public.letter_lines as line
             where line.letter_id = letter.id and line.party_id is not null), 0);

  select count(*) into v_inbound from public.letter_lines as line
    join public.letters as letter on letter.id = line.letter_id
   where letter.letter_type = 'inbound';

  select count(*) into v_treedrafts from public.letters
   where letter_type = 'inbound' and status = 'draft';

  raise notice 'aps multi-party [%]: % inbound line(s), % draft inbound letter(s) ready for the tree', v_label, v_inbound, v_treedrafts;
  raise notice 'aps multi-party [%]: missing party = %, stray party = %, party_count mismatch = %',
    v_label, v_missing, v_stray, v_counter;
  raise notice 'aps multi-party [%]: %', v_label,
    case when v_missing = 0 and v_stray = 0 and v_counter = 0
         then 'PASS — every inbound line carries its party, no other line does, counters match'
         else 'FAIL — do not release the UI until the three numbers above are zero'
    end;
end
$preflight$;
