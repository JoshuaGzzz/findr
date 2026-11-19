-- Optional demo items. Run AFTER 0002 and after you have created at least one staff account
-- (see README: promote a user to staff). Items are attributed to the first staff profile.
with s as (select id from public.profiles where role = 'staff' order by id limit 1)
insert into public.items (title, category, gate, tags, description, found_at, status, finder_id, source)
select v.title, v.category, v.gate, v.tags, v.descr, now() - v.age, 'unclaimed', s.id, 'staff'
from s, (values
  ('Black umbrella',            'umbrellas',  'g-lib',  array['black','folding'],   'Compact folding umbrella left on a reading table.', interval '3 days'),
  ('Blue Hydro Flask tumbler',  'bottles',    'g-gym',  array['blue','steel'],      'Insulated tumbler found at the bleachers.',        interval '5 days'),
  ('Black wallet',              'wallets',    'g-main', array['black','leather'],   'Bifold wallet handed in by a student.',            interval '2 days'),
  ('Grey backpack',             'bags',       'g-eng',  array['grey','nike'],       'Backpack left in the engineering lobby.',          interval '12 days'),
  ('AirPods case',              'electronics','g-lib',  array['white','earbuds'],   'White earbuds charging case.',                     interval '4 days')
) as v(title, category, gate, tags, descr, age);
