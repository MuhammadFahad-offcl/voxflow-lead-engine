# Dental clinic call script — template v1 (draft)

<!--
Rules for the script agent (FR-18):
- Fill only the {{variables}}. Do not add claims, prices, statistics or promises.
- {{evidenceSummary}} must restate a stored signal's evidence in one short Urdu sentence.
- The OPENING always says it is an AI assistant and that the call is recorded (NFR-7). Never remove either.
- Keep each spoken turn under 2 sentences. The caller asks, then waits.
- Branch names in [BRACKETS] are read by the caller agent's system prompt, not spoken.

Variables:
  {{assistantName}}     voice persona name, from Settings
  {{clinicName}}        Lead.name
  {{doctorName}}        Lead.decisionMakerName or "ڈاکٹر صاحب"
  {{evidenceSummary}}   from the Solution's signals
  {{serviceName}}       Service.name in Urdu
  {{expectedResult}}    Service.expectedResult in Urdu, no numbers
  {{founderName}}       "فہد"
  {{meetingMinutes}}    Settings.booking.meetingMinutes
-->

[OPENING]
السلام علیکم۔ میں VoxFlow AI Solutions کی AI اسسٹنٹ {{assistantName}} ہوں، اور یہ کال ریکارڈ ہو رہی ہے۔ کیا میری بات {{clinicName}} سے ہو رہی ہے؟

[DECISION_MAKER_CHECK]
کیا {{doctorName}} یا کلینک کے مالک سے ایک منٹ بات ہو سکتی ہے؟

[PERMISSION]
میں صرف ایک منٹ لوں گی/گا — کیا ابھی بات کرنا ٹھیک ہے؟

[HOOK]
ہم نے آپ کے کلینک کے گوگل ریویوز دیکھے۔ {{evidenceSummary}}

[OFFER]
ہم کلینکس کے لیے {{serviceName}} لگاتے ہیں، جس سے {{expectedResult}}۔

[ASK]
کیا آپ اس ہفتے {{founderName}} صاحب کے ساتھ {{meetingMinutes}} منٹ کی ویڈیو کال کے لیے وقت نکال سکتے ہیں؟ وہ آپ کو یہ پورا طریقہ دکھا دیں گے۔

[BOOKING]
→ call tool get-slots, offer the 2 earliest slots in Urdu (day + time, PKT).
→ on a choice, call tool book-slot. If the slot is gone, offer the next 2.
→ confirm: "آپ کی میٹنگ {{slotSpoken}} کو بُک ہو گئی ہے۔ {{founderName}} صاحب آپ کو واٹس ایپ پر لنک بھیج دیں گے۔"
→ ask: "کیا یہی نمبر واٹس ایپ پر ہے؟"

[NOT_DECISION_MAKER]
کوئی بات نہیں۔ {{doctorName}} سے بات کرنے کا بہترین وقت کون سا ہوگا؟ اور ان کا نام کیا ہے؟
→ record decisionMakerName and callbackAt. Result NOT_DECISION_MAKER or CALLBACK_REQUESTED.

[BUSY]
میں سمجھ سکتی/سکتا ہوں۔ کب کال کرنا آپ کے لیے بہتر ہوگا؟
→ Result CALLBACK_REQUESTED with callbackAt.

[OBJECTION_PRICE]
قیمت کلینک کی ضرورت کے مطابق ہوتی ہے — یہ {{founderName}} صاحب کال پر بتا دیں گے۔ کال کی کوئی فیس نہیں ہے۔
→ return to [ASK] once. Never quote a price.

[OBJECTION_HAS_SOLUTION]
بہت اچھی بات ہے۔ کیا وہ سسٹم رات کو اور چھٹی والے دن بھی کالز سنبھال لیتا ہے؟
→ return to [ASK] once, then [CLOSE_NO].

[OBJECTION_DISTRUSTS_AI]
بالکل جائز سوال ہے۔ اسی لیے میٹنگ انسان سے ہوگی — {{founderName}} صاحب خود سب کچھ دکھائیں گے۔
→ return to [ASK] once, then [CLOSE_NO].

[CLOSE_NO]
آپ کے وقت کا بہت شکریہ۔ اللہ حافظ۔
→ Result NOT_INTERESTED with a reasonCode.

[DO_NOT_CALL]
معذرت چاہتی/چاہتا ہوں۔ آپ کا نمبر ہماری لسٹ سے ہٹا دیا جائے گا۔ اللہ حافظ۔
→ Result DO_NOT_CALL. The outcome agent adds the number to DoNotCall (FR-29).

[WRONG_NUMBER]
معذرت، غلط نمبر لگ گیا۔ اللہ حافظ۔
→ Result WRONG_NUMBER.

[VOICEMAIL_OR_SILENCE]
→ hang up without a message. Result NO_ANSWER.
