// Receiving from abroad: the same link, paid in dollars or any Solana token, claimed in naira or
// kept in dollars.
const POINTS = [
  {
    title: "Arrives as dollars",
    body: "Any Solana token lands as dollars. No swapping on your side.",
    tint: "bg-sage-100",
  },
  {
    title: "No domiciliary account",
    body: "Your number is all it takes to receive. No forms, no waiting.",
    tint: "bg-lemon-100",
  },
  {
    title: "Rate before you confirm",
    body: "See exactly how much naira you get before you cash out. Or keep dollars for later.",
    tint: "bg-rose-100",
  },
];

export function GetPaidSection() {
  return (
    <section id="get-paid" className="scroll-mt-6 bg-cream py-20 md:py-28">
      <div className="mx-auto max-w-6xl px-4 md:px-8">
        <p className="text-sm font-medium text-ink/55">Get paid from abroad</p>
        <h2 className="mt-3 max-w-[18ch] text-[40px] leading-[0.95] font-medium tracking-[-0.035em] text-ink md:text-[64px]">
          Get paid from anywhere. Spend in naira.
        </h2>
        <p className="mt-5 max-w-[52ch] text-base text-ink/60 md:text-lg">
          Paid by a client, a platform or family abroad, in USD, USDT or any token on Solana? Send
          them your Muuve link. You verify your number and choose: keep dollars, or cash out to any
          Nigerian bank or OPay at a rate you see before you confirm.
        </p>
        <ul className="m-0 mt-10 grid list-none grid-cols-1 gap-4 p-0 md:grid-cols-3">
          {POINTS.map((p) => (
            <li key={p.title} className={`rounded-[28px] p-6 md:p-7 ${p.tint}`}>
              <h3 className="m-0 text-[22px] font-medium tracking-[-0.02em] text-ink">{p.title}</h3>
              <p className="m-0 mt-2 text-[15px] text-ink/65">{p.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
