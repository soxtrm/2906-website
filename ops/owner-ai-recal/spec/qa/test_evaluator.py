import unittest
from pathlib import Path
import importlib.util
spec=importlib.util.spec_from_file_location('eval_runner',Path(__file__).with_name('evaluate_decisions.py'))
evalrunner=importlib.util.module_from_spec(spec);spec.loader.exec_module(evalrunner)

class EvaluatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases=evalrunner.read_jsonl(Path(__file__).with_name('ARGUS_GOLDEN_OWNER_CASES_2026-11-10.jsonl'))
        cls.byid={c['id']:c for c in cls.cases}
    def test_catalog_valid(self):
        self.assertEqual([],evalrunner.validate_fixtures(self.cases))
        self.assertEqual(len(self.cases),len(self.byid))
        self.assertGreaterEqual(len(self.cases),100)
    def test_correct_identity_direct_reply(self):
        e=self.byid['S01'];a={'id':'S01','next_action':'ANSWER_DIRECT','reason_code':'OWNER_DIRECT_QUESTION','fact_mutations':{},'draft_reply':'Yes, I am an agent in Malta, working with QuickLets.','did_send':False,'send_eligible':True}
        self.assertEqual([],evalrunner.compare(e,a))
    def test_wrong_identity_reply_fails(self):
        e=self.byid['S01'];a={'next_action':'ASK_SINGLE_MISSING','reason_code':'OWNER_DIRECT_QUESTION','fact_mutations':{},'draft_reply':'How many bedrooms are there?','did_send':False,'send_eligible':True}
        self.assertTrue(evalrunner.compare(e,a))
    def test_do_not_contact_dispatch_fails(self):
        e=self.byid['S20'];a={'next_action':'DNC','reason_code':'DNC','fact_mutations':e['expected_fact_deltas'],'draft_reply':'','did_send':True,'send_eligible':True}
        self.assertTrue(any('FORBIDDEN' in t for t in evalrunner.compare(e,a)))
    def test_safe_no_send(self):
        e=self.byid['S08'];a={'next_action':'NO_SEND','reason_code':'LONG_TERM_RENTED','fact_mutations':e['expected_fact_deltas'],'draft_reply':None,'did_send':False,'send_eligible':False}
        self.assertEqual([],evalrunner.compare(e,a))
    def test_empty_reply_to_direct_question_fails(self):
        e=self.byid['S01'];a={'next_action':'ANSWER_DIRECT','reason_code':'OWNER_DIRECT_QUESTION','fact_mutations':{},'draft_reply':'','did_send':False,'send_eligible':True}
        self.assertTrue(any('missing candidate reply' in t for t in evalrunner.compare(e,a)))
    def test_missing_factual_update_fails(self):
        e=self.byid['S06'];a={'next_action':'ACKNOWLEDGE_UPDATE','reason_code':'PRICE_CORRECTION','fact_mutations':{'marketable':True},'draft_reply':'Thanks, €2,800 and available noted.','did_send':False,'send_eligible':True}
        self.assertIn('missing factual mutation: asking_rent',evalrunner.compare(e,a))

if __name__=='__main__':unittest.main()
