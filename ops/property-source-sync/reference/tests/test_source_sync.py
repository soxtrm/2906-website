import copy,json,sys,tempfile,unittest
from pathlib import Path
P=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(P/'prototype'))
from source_adapter import amount, canonical_url, candidate_prices, links_from_category, parse_detail, select_price, fingerprint
from store import connect, add_source, ingest_snapshot, decide, stats, list_proposals

class TestSourceAdapter(unittest.TestCase):
    def test_01_single_rent(self):
        p=select_price(['€ 1,500 monthly'],'long_let'); self.assertEqual(p['amount'],'1500');self.assertFalse(p['review_required'])
    def test_02_choose_cheaper_explicit_current_rent(self):
        p=select_price(['€ 1,500 monthly','Rent: € 1,400 monthly'],'long_let');self.assertEqual(p['amount'],'1400');self.assertTrue(p['review_required'])
    def test_03_ignore_wifi_and_deposit(self):
        p=select_price(['Rent: € 1,300 monthly','WiFi € 45 monthly','Security deposit € 1,300','Utilities deposit 100€'], 'long_let');self.assertEqual(p['amount'],'1300');self.assertEqual(len(p['candidate_prices']),1)
    def test_04_no_invented_price(self):
        p=select_price(['Price on request','Utilities deposit: €100'], 'long_let');self.assertIsNone(p['amount'])
    def test_05_ignore_weekly_rent(self):
        p=select_price(['€ 900 weekly', 'Rent € 1,500 monthly'],'long_let');self.assertEqual(p['amount'],'1500')
    def test_06_sale_price(self):
        p=select_price(['€ 255,000','Sale Price: €255,000 (Freehold)'],'sale');self.assertEqual(p['amount'],'255000');self.assertFalse(p['review_required'])
    def test_07_choose_cheaper_sale(self):
        p=select_price(['€ 255,000','Sale Price: €245,000'],'sale');self.assertEqual(p['amount'],'245000');self.assertTrue(p['review_required'])
    def test_08_ignore_service_fees_sale(self):
        p=select_price(['€255,000','Agency fee €3,000','Deposit €1000'],'sale');self.assertEqual(p['amount'],'255000')
    def test_09_euro_after_number(self):
        self.assertEqual(select_price(['For rent at 1,200€ monthly'],'long_let')['amount'],'1200')
    def test_10_number_locales(self):
        self.assertEqual(amount('1,300'),1300);self.assertEqual(amount('1.300'),1300);self.assertEqual(amount('1,300.50'),1300.50)
    def test_11_no_cross_domain(self):
        with self.assertRaises(ValueError):canonical_url('http://169.254.169.254/latest/meta-data')
    def test_12_canonical_trackers(self):
        self.assertEqual(canonical_url('https://www.mynexthome.mt/long-let/?ref=spam'),'https://www.mynexthome.mt/long-let/')
    def test_13_extract_links(self):
        html='<a href="/directory-apartments/listing/unit-a/">A</a><a href="/directory-apartments/listing/unit-a?x=1">A</a><a href="https://evil.com/directory-apartments/listing/unit-z/">X</a>'
        self.assertEqual(links_from_category(html, 'https://www.mynexthome.mt/long-let/'),['https://www.mynexthome.mt/directory-apartments/listing/unit-a/'])
    def test_14_category_from_source(self):
        html='''<html><h1>Hamrun 2-bedroom 3rd Floor Apartment</h1><button>Short Let</button><button>For Sale</button><div>€ 1,600 monthly</div><p>Property Address:</p><p>49 Blue Hues Apartment 3</p><section>Available 01/11/2026<br>Bedrooms<br>2<br>Bathrooms<br>2<br>Total area<br>69.2 sqm</section><p>Rent: € 1,600 monthly</p><p>WiFi 50€ monthly</p></html>'''
        item=parse_detail(html,'https://www.mynexthome.mt/directory-apartments/listing/unit-a/','long_let')
        self.assertEqual(item['category'],'long_let');self.assertEqual(item['price']['amount'],'1600');self.assertEqual(item['bedrooms'],2)
    def test_15_sales_as_sale_even_pills(self):
        html='<h1>Bugibba First Floor Apartment</h1><button>Long Let</button><p>€ 255,000</p>'
        item=parse_detail(html,'https://www.mynexthome.mt/directory-apartments/listing/sale-a/','sale')
        self.assertEqual(item['price']['amount'],'255000')
    def test_16_no_first_seen_rented(self):
        html='<h1>Some Flat</h1><p>Rented three years ago.</p><p>€ 1,200 monthly</p>'
        item=parse_detail(html,'https://www.mynexthome.mt/directory-apartments/listing/flat/','long_let')
        self.assertEqual(item['availability_state'],'SOURCE_LISTED_UNVERIFIED')

class TestDiffReview(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.db=connect(str(Path(self.tmp.name)/'test.db'))
        self.l=add_source(self.db,'My Next Home Long Let','https://www.mynexthome.mt/long-let/','long_let')
        self.s=add_source(self.db,'My Next Home Sale','https://www.mynexthome.mt/for-sale/','sale')
        data=json.loads((P/'fixtures'/'observed_2026-11-09.json').read_text())['listings']
        self.r=[x for x in data if x['category']=='long_let'];self.sale=[x for x in data if x['category']=='sale']
    def tearDown(self):self.db.close();self.tmp.cleanup()
    def test_17_initial_new_count(self):
        out=ingest_snapshot(self.db,self.l,self.r);self.assertEqual(out['new'],4);self.assertEqual(stats(self.db)['new'],4)
    def test_18_idempotent_repeat(self):
        ingest_snapshot(self.db,self.l,self.r);out=ingest_snapshot(self.db,self.l,self.r);self.assertEqual(out['new'],0);self.assertEqual(out['updated'],0)
    def test_19_price_update_creates_proposal(self):
        ingest_snapshot(self.db,self.l,self.r)
        new=copy.deepcopy(self.r);new[0]['price']['amount']='1250'
        self.assertEqual(ingest_snapshot(self.db,self.l,new)['updated'],1)
        self.assertEqual(stats(self.db)['updated'],1)
    def test_20_newer_price_may_be_higher(self):
        ingest_snapshot(self.db,self.l,self.r)
        new=copy.deepcopy(self.r);new[0]['price']['amount']='1600'
        ingest_snapshot(self.db,self.l,new)
        updated=[x for x in list_proposals(self.db) if x['event_type']=='UPDATED'][0]
        self.assertEqual(updated['details']['source']['price']['amount'],'1600')
    def test_21_missing_once_no_rented(self):
        ingest_snapshot(self.db,self.l,self.r);out=ingest_snapshot(self.db,self.l,self.r[1:]);self.assertEqual(out['missing_flagged'],0)
    def test_22_missing_twice_requires_review(self):
        ingest_snapshot(self.db,self.l,self.r);ingest_snapshot(self.db,self.l,self.r[1:]);out=ingest_snapshot(self.db,self.l,self.r[1:]);self.assertEqual(out['missing_flagged'],1)
        prop=[x for x in list_proposals(self.db) if x['event_type']=='MISSING_FROM_SOURCE'][0]
        self.assertIn('Do NOT infer rented',prop['details']['note'])
    def test_23_no_cross_category(self):
        with self.assertRaises(ValueError):ingest_snapshot(self.db,self.l,self.sale)
    def test_24_no_auto_apply(self):
        ingest_snapshot(self.db,self.l,self.r)
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM approved_imports').fetchone()[0],0)
    def test_25_approval_local_only(self):
        ingest_snapshot(self.db,self.l,self.r)
        proposal=list_proposals(self.db)[0];decide(self.db,proposal['id'],'APPROVED')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM approved_imports').fetchone()[0],1)
    def test_26_rejection(self):
        ingest_snapshot(self.db,self.l,self.r);proposal=list_proposals(self.db)[0];decide(self.db,proposal['id'],'REJECTED')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM approved_imports').fetchone()[0],0)
    def test_27_duplicate_same_listing_in_scan(self):
        out=ingest_snapshot(self.db,self.l,self.r+[self.r[0]]);self.assertEqual(out['items_seen'],4)
    def test_28_sales_distinct(self):
        ing=ingest_snapshot(self.db,self.s,self.sale);self.assertEqual(ing['new'],4)
    def test_29_stale_decision_refused(self):
        ingest_snapshot(self.db,self.l,self.r)
        first=next(x for x in list_proposals(self.db) if x['external_id']==self.r[0]['external_id'])
        nxt=copy.deepcopy(self.r);nxt[0]['price']['amount']='1999';ingest_snapshot(self.db,self.l,nxt)
        with self.assertRaises(ValueError):decide(self.db,first['id'],'APPROVED')
    def test_30_short_let_rejected(self):
        with self.assertRaises(ValueError):add_source(self.db,'Shortlet','https://www.mynexthome.mt/short-let/','short_let')
    def test_31_private_address_not_in_preview(self):
        val=copy.deepcopy(self.r);val[0]['private_address_candidate']='Sensitive address';ingest_snapshot(self.db,self.l,val)
        candidate=[x for x in list_proposals(self.db) if x['external_id']==val[0]['external_id']][0]
        self.assertNotIn('Sensitive address',str(candidate['details']))

if __name__=='__main__':unittest.main()
