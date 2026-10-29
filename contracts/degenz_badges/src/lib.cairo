// Starknet Degenz Badges: the profile badges from starknetdegenz.fun as ERC-721 tokens.
//
// Every token is one badge (Wolf, Week Wolf, Inferno, ...). Token ids count up from 1 in mint order, and
// badge_of(token_id) says which badge a token is. A wallet can mint each badge once, from its own wallet,
// paying only the network fee. Tokens are ordinary ERC-721s: they can be transferred and sold like any NFT.
//
// What lets a wallet mint is a voucher: a signature from the site's signing key over
// (tag, chain, this contract, badge, wallet). The site hands one out only for a badge the wallet has earned
// on its profile. A voucher works only for the wallet it names, on this contract, on this chain, and never
// expires.
//
// The signing key can only say "this wallet earned this badge". It holds no funds and cannot mint, move or
// burn anything itself. The owner can replace the signing key (if it were ever stolen) and change where the
// token metadata is served from, and nothing else: the owner cannot mint for anyone, or move or burn a token.

use starknet::ContractAddress;

#[starknet::interface]
pub trait IDegenzBadges<TState> {
    /// Mint the caller's token for `badge` (the badge id as a short string, e.g. 'wolf'). (r, s) is the voucher.
    fn claim(ref self: TState, badge: felt252, r: felt252, s: felt252);
    fn has_claimed(self: @TState, badge: felt252, wallet: ContractAddress) -> bool;
    fn badge_of(self: @TState, token_id: u256) -> felt252;
    fn total_minted(self: @TState) -> u256;
    fn signer(self: @TState) -> felt252;
    // owner only
    fn set_signer(ref self: TState, public_key: felt252);
    fn set_base_uri(ref self: TState, base_uri: ByteArray);
}

#[starknet::contract]
pub mod DegenzBadges {
    use core::ecdsa::check_ecdsa_signature;
    use core::pedersen::pedersen;
    use openzeppelin_access::ownable::OwnableComponent;
    use openzeppelin_introspection::src5::SRC5Component;
    use openzeppelin_token::erc721::{ERC721Component, ERC721HooksEmptyImpl};
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess, StoragePointerWriteAccess,
    };
    use starknet::{ContractAddress, get_caller_address, get_contract_address, get_tx_info};

    component!(path: ERC721Component, storage: erc721, event: ERC721Event);
    component!(path: SRC5Component, storage: src5, event: SRC5Event);
    component!(path: OwnableComponent, storage: ownable, event: OwnableEvent);

    // ERC-721 (with metadata and SRC-5, so wallets and marketplaces recognise it) and ownership, from OpenZeppelin
    #[abi(embed_v0)]
    impl ERC721MixinImpl = ERC721Component::ERC721MixinImpl<ContractState>;
    impl ERC721InternalImpl = ERC721Component::InternalImpl<ContractState>;
    #[abi(embed_v0)]
    impl OwnableMixinImpl = OwnableComponent::OwnableMixinImpl<ContractState>;
    impl OwnableInternalImpl = OwnableComponent::InternalImpl<ContractState>;

    // what a voucher is for, so a signature made for anything else can never mint here
    const TAG: felt252 = 'degenz.badge';

    #[storage]
    struct Storage {
        #[substorage(v0)]
        erc721: ERC721Component::Storage,
        #[substorage(v0)]
        src5: SRC5Component::Storage,
        #[substorage(v0)]
        ownable: OwnableComponent::Storage,
        signer_key: felt252,
        claimed: Map<(felt252, ContractAddress), bool>,
        badge: Map<u256, felt252>,
        minted: u256,
    }

    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        #[flat]
        ERC721Event: ERC721Component::Event,
        #[flat]
        SRC5Event: SRC5Component::Event,
        #[flat]
        OwnableEvent: OwnableComponent::Event,
        BadgeClaimed: BadgeClaimed,
        SignerChanged: SignerChanged,
    }

    #[derive(Drop, starknet::Event)]
    struct BadgeClaimed {
        #[key]
        wallet: ContractAddress,
        #[key]
        badge: felt252,
        token_id: u256,
    }

    #[derive(Drop, starknet::Event)]
    struct SignerChanged {
        public_key: felt252,
    }

    #[constructor]
    fn constructor(ref self: ContractState, owner: ContractAddress, signer: felt252, base_uri: ByteArray) {
        assert(signer != 0, 'No signer');
        self.erc721.initializer("Starknet Degenz Badges", "DGZB", base_uri);
        self.ownable.initializer(owner);
        self.signer_key.write(signer);
    }

    /// What the site signs: pedersen over (tag, chain id, this contract, badge, wallet), left to right.
    /// The chain and the contract are in it so a voucher is good here and nowhere else.
    fn voucher_hash(badge: felt252, wallet: ContractAddress) -> felt252 {
        let chain = get_tx_info().unbox().chain_id;
        let here: felt252 = get_contract_address().into();
        pedersen(pedersen(pedersen(pedersen(TAG, chain), here), badge), wallet.into())
    }

    #[abi(embed_v0)]
    impl DegenzBadgesImpl of super::IDegenzBadges<ContractState> {
        fn claim(ref self: ContractState, badge: felt252, r: felt252, s: felt252) {
            let caller = get_caller_address();
            assert(badge != 0, 'No badge');
            assert(check_ecdsa_signature(voucher_hash(badge, caller), self.signer_key.read(), r, s), 'Bad voucher');
            assert(!self.claimed.read((badge, caller)), 'Already claimed');
            let token_id = self.minted.read() + 1;
            self.claimed.write((badge, caller), true);
            self.minted.write(token_id);
            self.badge.write(token_id, badge);
            self.erc721.mint(caller, token_id);
            self.emit(BadgeClaimed { wallet: caller, badge, token_id });
        }

        fn has_claimed(self: @ContractState, badge: felt252, wallet: ContractAddress) -> bool {
            self.claimed.read((badge, wallet))
        }

        fn badge_of(self: @ContractState, token_id: u256) -> felt252 {
            self.badge.read(token_id)
        }

        fn total_minted(self: @ContractState) -> u256 {
            self.minted.read()
        }

        fn signer(self: @ContractState) -> felt252 {
            self.signer_key.read()
        }

        /// Replaces the signing key. Vouchers signed by the old key stop working at once.
        fn set_signer(ref self: ContractState, public_key: felt252) {
            self.ownable.assert_only_owner();
            assert(public_key != 0, 'No signer');
            self.signer_key.write(public_key);
            self.emit(SignerChanged { public_key });
        }

        fn set_base_uri(ref self: ContractState, base_uri: ByteArray) {
            self.ownable.assert_only_owner();
            self.erc721._set_base_uri(base_uri);
        }
    }
}
