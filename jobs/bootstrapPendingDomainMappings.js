const mongoose = require('mongoose');
const Brand = require('../models/Brand');
const EmailMessage = require('../models/EmailMessage');
const { connectDB } = require('../config/database');
const { normalizeDomain, getRegistrableDomain } = require('../utils/domainIdentity');

const DOMAIN_BOOTSTRAP = [
  {
    senderDomain: 'mail.jcrew.com',
    brandName: 'J.Crew',
    brandDomain: 'jcrew.com',
    websiteUrl: 'https://www.jcrew.com'
  },
  {
    senderDomain: 'ayr.com',
    brandName: 'AYR',
    brandDomain: 'ayr.com',
    websiteUrl: 'https://www.ayr.com'
  },
  {
    senderDomain: 'news.anker.com',
    brandName: 'Anker',
    brandDomain: 'anker.com',
    websiteUrl: 'https://www.anker.com'
  },
  {
    senderDomain: 'e.dcsg.com',
    brandName: "DICK'S Sporting Goods",
    brandDomain: 'dickssportinggoods.com',
    websiteUrl: 'https://www.dickssportinggoods.com'
  },
  {
    senderDomain: 'abrandjeans.com',
    brandName: 'Abrand Jeans',
    brandDomain: 'abrandjeans.com',
    websiteUrl: 'https://www.abrandjeans.com'
  },
  {
    senderDomain: 'info.asics.com',
    brandName: 'ASICS',
    brandDomain: 'asics.com',
    websiteUrl: 'https://www.asics.com'
  },
  {
    senderDomain: 'email.abbavoyage.com',
    brandName: 'ABBA Voyage',
    brandDomain: 'abbavoyage.com',
    websiteUrl: 'https://www.abbavoyage.com'
  },
  {
    senderDomain: '1stincoffee.com',
    brandName: '1st in Coffee',
    brandDomain: '1stincoffee.com',
    websiteUrl: 'https://www.1stincoffee.com'
  },
  {
    senderDomain: 'emails.reebok.com',
    brandName: 'Reebok',
    brandDomain: 'reebok.com',
    websiteUrl: 'https://www.reebok.com'
  },
  {
    senderDomain: 'smile.colgate.com',
    brandName: 'Colgate',
    brandDomain: 'colgate.com',
    websiteUrl: 'https://www.colgate.com'
  },
  {
    senderDomain: 'b.express.com',
    brandName: 'Express',
    brandDomain: 'express.com',
    websiteUrl: 'https://www.express.com'
  },
  {
    senderDomain: 'e.rejuvenation.com',
    brandName: 'Rejuvenation',
    brandDomain: 'rejuvenation.com',
    websiteUrl: 'https://www.rejuvenation.com'
  },
  {
    senderDomain: 'int.revolve.com',
    brandName: 'REVOLVE',
    brandDomain: 'revolve.com',
    websiteUrl: 'https://www.revolve.com'
  },
  {
    senderDomain: 'p.revolve.com',
    brandName: 'REVOLVE',
    brandDomain: 'revolve.com',
    websiteUrl: 'https://www.revolve.com'
  },
  {
    senderDomain: 'email.columbia.com',
    brandName: 'Columbia',
    brandDomain: 'columbia.com',
    websiteUrl: 'https://www.columbia.com'
  },
  {
    senderDomain: 's.anthropologie.com',
    brandName: 'Anthropologie',
    brandDomain: 'anthropologie.com',
    websiteUrl: 'https://www.anthropologie.com'
  },
  {
    senderDomain: 'email.oldnavy.com',
    brandName: 'Old Navy',
    brandDomain: 'oldnavy.com',
    websiteUrl: 'https://www.oldnavy.com'
  },
  {
    senderDomain: 'edm.anker.com',
    brandName: 'Anker',
    brandDomain: 'anker.com',
    websiteUrl: 'https://www.anker.com'
  },
  {
    senderDomain: 's.freepeople.com',
    brandName: 'Free People',
    brandDomain: 'freepeople.com',
    websiteUrl: 'https://www.freepeople.com'
  },
  {
    senderDomain: 'e1.victoriassecret.com',
    brandName: "Victoria's Secret",
    brandDomain: 'victoriassecret.com',
    websiteUrl: 'https://www.victoriassecret.com'
  },
  {
    senderDomain: 'email.hm.com',
    brandName: 'H&M',
    brandDomain: 'hm.com',
    websiteUrl: 'https://www.hm.com'
  },
  {
    senderDomain: 'mail.madewell.com',
    brandName: 'Madewell',
    brandDomain: 'madewell.com',
    websiteUrl: 'https://www.madewell.com'
  },
  {
    senderDomain: 'emails.underarmour.com',
    brandName: 'Under Armour',
    brandDomain: 'underarmour.com',
    websiteUrl: 'https://www.underarmour.com'
  },
  {
    senderDomain: 'email.bananarepublic.com',
    brandName: 'Banana Republic',
    brandDomain: 'bananarepublic.com',
    websiteUrl: 'https://www.bananarepublic.com'
  },
  {
    senderDomain: 'email.gap.com',
    brandName: 'GAP',
    brandDomain: 'gap.com',
    websiteUrl: 'https://www.gap.com'
  },
  {
    senderDomain: 'eml.nordstrom.com',
    brandName: 'Nordstrom',
    brandDomain: 'nordstrom.com',
    websiteUrl: 'https://www.nordstrom.com'
  },
  {
    senderDomain: 'hello.us.lush.com',
    brandName: 'Lush',
    brandDomain: 'lush.com',
    websiteUrl: 'https://www.lush.com'
  },
  {
    senderDomain: 's.urbanoutfitters.com',
    brandName: 'Urban Outfitters',
    brandDomain: 'urbanoutfitters.com',
    websiteUrl: 'https://www.urbanoutfitters.com'
  },
  {
    senderDomain: 'e.markandgraham.com',
    brandName: 'Mark and Graham',
    brandDomain: 'markandgraham.com',
    websiteUrl: 'https://www.markandgraham.com'
  },
  {
    senderDomain: 'e.westelm.com',
    brandName: 'West Elm',
    brandDomain: 'westelm.com',
    websiteUrl: 'https://www.westelm.com'
  },
  {
    senderDomain: 'e.potterybarnkids.com',
    brandName: 'Pottery Barn Kids',
    brandDomain: 'potterybarnkids.com',
    websiteUrl: 'https://www.potterybarnkids.com'
  },
  {
    senderDomain: 'e.williams-sonoma.com',
    brandName: 'Williams Sonoma',
    brandDomain: 'williams-sonoma.com',
    websiteUrl: 'https://www.williams-sonoma.com'
  },
  {
    senderDomain: 'email.athleta.com',
    brandName: 'Athleta',
    brandDomain: 'athleta.com',
    websiteUrl: 'https://www.athleta.com'
  },
  {
    senderDomain: 'email.newbalance.com',
    brandName: 'New Balance',
    brandDomain: 'newbalance.com',
    websiteUrl: 'https://www.newbalance.com'
  },
  {
    senderDomain: 'em.target.com',
    brandName: 'Target',
    brandDomain: 'target.com',
    websiteUrl: 'https://www.target.com'
  },
  {
    senderDomain: 'e.pbteen.com',
    brandName: 'PBteen',
    brandDomain: 'pbteen.com',
    websiteUrl: 'https://www.pbteen.com'
  },
  {
    senderDomain: 'e.potterybarn.com',
    brandName: 'Pottery Barn',
    brandDomain: 'potterybarn.com',
    websiteUrl: 'https://www.potterybarn.com'
  },
  {
    senderDomain: 'orders.express.com',
    brandName: 'Express',
    brandDomain: 'express.com',
    websiteUrl: 'https://www.express.com'
  },
  {
    senderDomain: 'atoms.com',
    brandName: 'Atoms',
    brandDomain: 'atoms.com',
    websiteUrl: 'https://www.atoms.com'
  },
  {
    senderDomain: 'e.greenrow.com',
    brandName: 'GreenRow',
    brandDomain: 'greenrow.com',
    websiteUrl: 'https://www.greenrow.com'
  },
  {
    senderDomain: 'notices.rei.com',
    brandName: 'REI',
    brandDomain: 'rei.com',
    websiteUrl: 'https://www.rei.com'
  },
  {
    senderDomain: 'bm.revolve.com',
    brandName: 'REVOLVE',
    brandDomain: 'revolve.com',
    websiteUrl: 'https://www.revolve.com'
  },
  {
    senderDomain: 'beauty.sephora.com',
    brandName: 'Sephora',
    brandDomain: 'sephora.com',
    websiteUrl: 'https://www.sephora.com'
  },
  {
    senderDomain: 'autoemail.hm.com',
    brandName: 'H&M',
    brandDomain: 'hm.com',
    websiteUrl: 'https://www.hm.com'
  }
];

function toLowerSet(values = []) {
  return Array.from(new Set(values.map((v) => String(v || '').toLowerCase().trim()).filter(Boolean)));
}

async function upsertBrandMapping(mapping) {
  const senderDomain = normalizeDomain(mapping.senderDomain);
  const brandDomain = normalizeDomain(mapping.brandDomain);
  const senderApex = getRegistrableDomain(senderDomain) || senderDomain;
  const knownDomains = toLowerSet([senderDomain, senderApex, brandDomain]);

  const brand = await Brand.findOneAndUpdate(
    { domain: brandDomain },
    {
      $setOnInsert: {
        name: mapping.brandName,
        domain: brandDomain,
        websiteUrl: mapping.websiteUrl,
        source: 'manual',
        discoveredAt: new Date()
      },
      $set: {
        onboardingStatus: 'active',
        statusUpdatedAt: new Date()
      },
      $addToSet: {
        knownSenderDomains: { $each: knownDomains }
      }
    },
    { upsert: true, new: true }
  );

  const senderEmails = await EmailMessage.distinct('fromEmail', {
    fromDomain: senderDomain,
    fromEmail: { $type: 'string', $ne: '' }
  });
  const cleanedEmails = toLowerSet(senderEmails);
  if (cleanedEmails.length) {
    brand.knownSenderEmails = toLowerSet([...(brand.knownSenderEmails || []), ...cleanedEmails]);
    await brand.save();
  }

  return { brand, senderDomain };
}

async function resolvePendingForDomain(senderDomain, brandId) {
  const now = new Date();
  const emailResult = await EmailMessage.updateMany(
    {
      fromDomain: senderDomain,
      state: 'brand_unresolved'
    },
    {
      $set: {
        brandId,
        state: 'brand_resolved',
        needsReview: false,
        classificationConfidence: 10,
        classificationReason: 'manual_domain_bootstrap',
        'processedBy.identity_resolver.done': true,
        'processedBy.identity_resolver.at': now,
        'processedBy.identity_resolver.status': 'done',
        'processedBy.identity_resolver.lastProcessedAt': now,
        'processedBy.identity_resolver.error': null,
        'processingTrace.resolve': {
          at: now,
          status: 'resolved',
          reason: 'manual_domain_bootstrap',
          confidence: 10
        }
      },
      $inc: {
        'processedBy.identity_resolver.attempts': 1
      }
    }
  );

  const queue = mongoose.connection.db.collection('manual_review_queue');
  const queueResult = await queue.updateMany(
    {
      fromDomain: senderDomain,
      status: 'pending'
    },
    {
      $set: {
        status: 'resolved_auto',
        resolution: 'domain_bootstrap',
        resolvedAt: now,
        resolvedBrandId: brandId
      }
    }
  );

  return {
    emailResolved: emailResult.modifiedCount || 0,
    queueResolved: queueResult.modifiedCount || 0
  };
}

async function run() {
  await connectDB();
  const summary = [];
  for (const mapping of DOMAIN_BOOTSTRAP) {
    const { brand, senderDomain } = await upsertBrandMapping(mapping);
    const resolved = await resolvePendingForDomain(senderDomain, brand._id);
    summary.push({
      senderDomain,
      brandId: String(brand._id),
      brandName: brand.name,
      brandDomain: brand.domain,
      ...resolved
    });
  }

  const post = {
    manualReviewPending: await mongoose.connection.db.collection('manual_review_queue').countDocuments({ status: 'pending' }),
    brandUnresolved: await mongoose.connection.db.collection('email_messages').countDocuments({ state: 'brand_unresolved' })
  };

  console.log(JSON.stringify({ ok: true, summary, post }, null, 2));
  await mongoose.disconnect();
}

run().catch(async (err) => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
