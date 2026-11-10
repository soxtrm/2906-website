#!/usr/bin/env python3
"""Offline ARGUS QA contract evaluator. No model calls, network, or real WhatsApp messages.

Expected fixture format: `ARGUS_GOLDEN_OWNER_CASES_2026-11-10.jsonl`.
Actual output format: JSONL with id, next_action, reason_code, fact_mutations,
    draft_reply, did_send, send_eligible.
Run: python evaluate_decisions.py --self-test
     python evaluate_decisions.py --actual /path/to/candidate-traces.jsonl
Use a real ARGUS harness to produce candidate traces from the ACTUAL runtime.
"""
import argparse, json, re, sys
from pathlib import Path

BASE=Path(__file__).resolve().parent
GOLD=BASE/'ARGUS_GOLDEN_OWNER_CASES_2026-11-10.jsonl'
ACTIONS={'NO_SEND','ANSWER_DIRECT','ACKNOWLEDGE_UPDATE','ASK_SINGLE_MISSING','HUMAN_HANDOFF','WAIT_FOR_MEDIA','DEFER','DNC'}
REQUIRED={'id','latest_inbound_burst','relevant_prior_context','expected_action','expected_reason_code','expected_fact_deltas','expected_dispatch_blocked'}

def read_jsonl(path):
    data=[]
    for i,line in enumerate(path.read_text(encoding='utf-8').splitlines(),1):
        if not line.strip():continue
        try: item=json.loads(line)
        except Exception as exc: raise ValueError(f'{path}:{i}: {exc}')
        if not isinstance(item,dict):raise ValueError(f'{path}:{i}: non-object')
        data.append(item)
    return data

def validate_fixtures(rows):
    seen=set(); issues=[]
    for row in rows:
        missing=REQUIRED-set(row)
        if missing:issues.append((row.get('id','?'),f'missing {sorted(missing)}'))
        x=row.get('id')
        if x in seen:issues.append((x,'duplicate case id'))
        seen.add(x)
        if row.get('expected_action') not in ACTIONS:issues.append((x,'invalid action'))
        if row.get('expected_dispatch_blocked') not in (True,False):issues.append((x,'missing dispatch gate'))
        if row.get('expected_action') in ('DNC','DEFER','NO_SEND') and not row.get('expected_dispatch_blocked'):
            issues.append((x,'non-send action must block dispatch'))
    return issues

def normalized(s):return re.sub(r'\s+',' ',str(s).lower()).strip()

def facts_to_dict(value):
    if isinstance(value,dict):return value
    if isinstance(value,list):
        return {r.get('field'):r.get('new_value') for r in value if isinstance(r,dict) and 'field' in r}
    return {}

def compare(exp,act):
    issues=[]; xid=exp['id']; actual_action=act.get('next_action'); expected_action=exp['expected_action']
    if actual_action != expected_action:issues.append(f'expected action {expected_action}, actual {actual_action}')
    if act.get('reason_code')!=exp['expected_reason_code']:
        issues.append(f"expected reason {exp['expected_reason_code']}, actual {act.get('reason_code')}")
    for name,value in exp.get('expected_fact_deltas',{}).items():
        actual=facts_to_dict(act.get('fact_mutations'))
        if name not in actual:issues.append(f'missing factual mutation: {name}')
        elif actual[name]!=value:issues.append(f'fact {name}: expected {value!r}; actual {actual[name]!r}')
    if exp.get('expected_dispatch_blocked'):
        if act.get('did_send') is True:issues.append('FORBIDDEN outbound dispatch occurred')
        if act.get('send_eligible') is True:issues.append('send_eligible incorrectly true')
    reply=normalized(act.get('draft_reply') or '')
    if not exp.get('expected_dispatch_blocked') and expected_action in ('ANSWER_DIRECT','ACKNOWLEDGE_UPDATE','ASK_SINGLE_MISSING') and not reply:
        issues.append('missing candidate reply for expected human-facing response')
    if reply and expected_action not in ('NO_SEND','DEFER','DNC'):
        terms=exp.get('reply_must_contain_any',[])
        if terms and not any(normalized(term) in reply for term in terms):
            issues.append(f'missing required response concept (any of): {terms}')
        for term in exp.get('reply_must_not_contain',[]):
            if normalized(term) in reply:issues.append(f'forbidden phrase: {term!r}')
    if exp.get('expected_dispatch_blocked') and act.get('did_send') is True:issues.append('SAFETY REGRESSION')
    return issues

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--self-test',action='store_true',help='validate fixture catalogue only')
    p.add_argument('--actual',type=Path,help='path to model/ARGUS decision traces JSONL')
    args=p.parse_args()
    fixtures=read_jsonl(GOLD); errors=validate_fixtures(fixtures)
    if errors:
        for case,error in errors:print('FIXTURE ERROR',case,error)
        return 2
    print(f'Validated {len(fixtures)} golden fixtures. No ARGUS code was executed.')
    if args.self_test or not args.actual:return 0
    actual=read_jsonl(args.actual)
    results={}
    for row in actual:
        if row.get('id') in results:
            print('ACTUAL ERROR duplicate trace',row.get('id'));return 2
        results[row.get('id')]=row
    passed=0; failures=[]
    for exp in fixtures:
        if exp['id'] not in results:failures.append((exp['id'],['missing actual trace']));continue
        issues=compare(exp,results[exp['id']])
        if issues:failures.append((exp['id'],issues))
        else:passed+=1
    for c,errors in failures:
        print(f'FAIL {c}: '+' | '.join(errors))
    print(f'RESULT: {passed}/{len(fixtures)} fixtures passed; {len(failures)} failed/missing.')
    return 1 if failures else 0

if __name__=='__main__':sys.exit(main())
