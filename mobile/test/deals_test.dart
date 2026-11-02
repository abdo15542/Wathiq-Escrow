import 'package:flutter_test/flutter_test.dart';
import 'package:wathiq_mobile/main.dart';

Deal sampleDeal({
  String status = 'awaiting_funding',
  String? myRole = 'buyer',
  bool dispute = false,
  String? buyerVote,
  String? sellerVote,
  String? arbiterVote,
  String? timeoutRefundAt,
}) {
  return Deal(
    id: 7,
    offerId: null,
    title: 'Sample deal',
    asset: 'BNB',
    amount: 1.5,
    status: status,
    dispute: dispute,
    disputeReason: null,
    buyer: const DealParticipant(id: 1, email: 'buyer@example.com', displayName: 'Buyer'),
    seller: const DealParticipant(id: 2, email: 'seller@example.com', displayName: 'Seller'),
    arbiter: const DealParticipant(id: 3, email: 'arbiter@example.com', displayName: 'Arbiter'),
    buyerVote: buyerVote,
    sellerVote: sellerVote,
    arbiterVote: arbiterVote,
    myRole: myRole,
    fundedAt: status == 'awaiting_funding' ? null : '2026-01-01T00:00:00.000Z',
    deliveredAt: null,
    settledAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    timeoutRefundAt: timeoutRefundAt,
  );
}

void main() {
  group('Deal.fromJson', () {
    test('parses participants, votes, and role', () {
      final deal = Deal.fromJson({
        'id': 3,
        'offerId': 9,
        'title': 'Phone sale',
        'asset': 'BNB',
        'amount': 0.25,
        'status': 'funded',
        'dispute': true,
        'disputeReason': 'Late delivery',
        'participants': {
          'buyer': {'id': 1, 'email': 'b@x.ly', 'displayName': 'B'},
          'seller': {'id': 2, 'email': 's@x.ly', 'displayName': 'S'},
          'arbiter': {'id': 4, 'email': 'a@x.ly', 'displayName': 'A'},
        },
        'votes': {'buyer': 'release', 'seller': null, 'arbiter': null},
        'myRole': 'seller',
        'fundedAt': '2026-01-02T00:00:00.000Z',
        'deliveredAt': null,
        'settledAt': null,
        'createdAt': '2026-01-01T00:00:00.000Z',
        'timeoutRefundAt': '2026-02-01T00:00:00.000Z',
      });
      expect(deal.offerId, 9);
      expect(deal.seller.email, 's@x.ly');
      expect(deal.buyerVote, 'release');
      expect(deal.myVote, isNull);
      expect(deal.dispute, isTrue);
      expect(dealStatusLabel(deal.status), 'مموّلة — الضمان محتجز');
    });
  });

  group('dealActionsFor mirrors the API state machine', () {
    test('buyer funds or cancels before funding; seller only cancels; arbiter waits', () {
      expect(dealActionsFor(sampleDeal()), ['fund', 'cancel']);
      expect(dealActionsFor(sampleDeal(myRole: 'seller')), ['cancel']);
      expect(dealActionsFor(sampleDeal(myRole: 'arbiter')), isEmpty);
    });

    test('seller delivers once funded; everyone can vote and dispute', () {
      final funded = sampleDeal(status: 'funded', myRole: 'seller');
      expect(dealActionsFor(funded), containsAll(['deliver', 'voteRelease', 'voteRefund', 'dispute']));
      final buyerFunded = sampleDeal(status: 'funded');
      expect(dealActionsFor(buyerFunded), containsAll(['voteRelease', 'voteRefund', 'dispute']));
      expect(dealActionsFor(buyerFunded), isNot(contains('deliver')));
    });

    test('a recorded vote and an open dispute remove those actions', () {
      final voted = sampleDeal(status: 'delivered', buyerVote: 'release', dispute: true);
      expect(dealActionsFor(voted), isEmpty);
    });

    test('timeout refund appears only at or after the 30-day mark', () {
      final deal = sampleDeal(
        status: 'funded',
        timeoutRefundAt: '2026-01-31T00:00:00.000Z',
      );
      expect(dealActionsFor(deal, now: DateTime.parse('2026-01-30T00:00:00.000Z')), isNot(contains('timeoutRefund')));
      expect(dealActionsFor(deal, now: DateTime.parse('2026-01-31T00:00:00.000Z')), contains('timeoutRefund'));
    });

    test('settled deals expose no actions', () {
      for (final status in ['released', 'refunded', 'cancelled']) {
        expect(dealActionsFor(sampleDeal(status: status)), isEmpty);
      }
    });
  });
}
