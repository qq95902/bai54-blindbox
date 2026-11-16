// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Stateless renderer for BAI game token metadata and SVG card art.
contract BAICardMetadataRenderer {
    using Strings for uint256;

    function tokenURI(
        uint256 tokenId,
        uint8 face,
        uint8 tier,
        bool winning,
        bool synthesized,
        uint64 dayId
    ) external pure returns (string memory) {
        bool sealedBox = face == type(uint8).max;
        string memory label = sealedBox ? "Sealed BAI Box" : _faceName(face);
        string memory tierName = sealedBox ? "SEALED" : _tierName(tier);
        string memory styleName = sealedBox ? "Sealed" : _styleName(face);
        string memory outcome = sealedBox ? "Pending" : (winning ? "Winning" : "Non-winning");
        string memory accent = _tierColor(tier, sealedBox);
        string memory styleColor = sealedBox ? "#d7ff4f" : _styleColor(face);
        string memory image = string.concat(
            "data:image/svg+xml;base64,", Base64.encode(bytes(_cardSVG(tokenId, label, tierName, styleName, outcome, accent, styleColor, sealedBox)))
        );
        string memory json = string.concat(
            '{"name":"BAI ', label, ' #', tokenId.toString(),
            '","description":"A BAI Blind Box card. Card face and result are determined on-chain.",',
            '"image":"', image, '","attributes":[',
            '{"trait_type":"Card","value":"', label, '"},',
            '{"trait_type":"Rarity","value":"', tierName, '"},',
            '{"trait_type":"Style","value":"', styleName, '"},',
            '{"trait_type":"Result","value":"', outcome, '"},',
            '{"trait_type":"Day","value":"', uint256(dayId).toString(), '"},',
            '{"trait_type":"Synthesized","value":"', synthesized ? "Yes" : "No", '"}]}'
        );
        return string.concat("data:application/json;base64,", Base64.encode(bytes(json)));
    }

    function _cardSVG(
        uint256 tokenId,
        string memory label,
        string memory tier,
        string memory style,
        string memory outcome,
        string memory accent,
        string memory styleColor,
        bool sealedBox
    ) private pure returns (string memory) {
        string memory mark = sealedBox ? "BAI" : label;
        string memory caption = sealedBox ? "OPEN AFTER DAILY DRAW" : outcome;
        return string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 840"><defs>',
            '<linearGradient id="g" x2="1" y2="1"><stop stop-color="#141a22"/><stop offset="1" stop-color="#080b10"/></linearGradient>',
            '<radialGradient id="r"><stop stop-color="', accent, '" stop-opacity=".32"/><stop offset="1" stop-color="#080b10" stop-opacity="0"/></radialGradient>',
            '</defs><rect width="600" height="840" rx="38" fill="url(#g)"/>',
            '<rect x="22" y="22" width="556" height="796" rx="30" fill="none" stroke="', accent, '" stroke-width="8"/>',
            '<rect x="42" y="42" width="516" height="756" rx="22" fill="url(#r)"/>',
            '<path d="M45 165L165 45M45 245L245 45M45 325L325 45M45 405L405 45M45 485L485 45" stroke="', styleColor, '" stroke-opacity=".28" stroke-width="8"/>',
            '<path d="M75 110H525M75 730H525" stroke="', accent, '" stroke-opacity=".55" stroke-width="3"/>',
            '<text x="300" y="100" text-anchor="middle" fill="', accent, '" font-family="Arial,sans-serif" font-size="34" font-weight="700">', tier, '</text>',
            '<text x="300" y="390" text-anchor="middle" fill="', accent, '" font-family="Arial,sans-serif" font-size="', sealedBox ? "96" : "76", '" font-weight="800">', mark, '</text>',
            '<text x="300" y="475" text-anchor="middle" fill="#e8edf5" font-family="Arial,sans-serif" font-size="27">BAI BLIND BOX</text>',
            '<text x="300" y="555" text-anchor="middle" fill="', styleColor, '" font-family="Arial,sans-serif" font-size="22" font-weight="700">', style, '</text>',
            '<text x="300" y="680" text-anchor="middle" fill="', accent, '" font-family="Arial,sans-serif" font-size="24">', caption, '</text>',
            '<text x="300" y="765" text-anchor="middle" fill="#aab5c4" font-family="monospace" font-size="20">TOKEN #', tokenId.toString(), '</text></svg>'
        );
    }

    function _faceName(uint8 face) private pure returns (string memory) {
        if (face >= 52) return face == 52 ? "BTC" : "ETH";
        uint8 asset = face / 4;
        if (asset == 0) return "BNB";
        if (asset == 1) return "SOL";
        if (asset == 2) return "XRP";
        if (asset == 3) return "ADA";
        if (asset == 4) return "DOGE";
        if (asset == 5) return "AVAX";
        if (asset == 6) return "DOT";
        if (asset == 7) return "LINK";
        if (asset == 8) return "TON";
        if (asset == 9) return "NVDA";
        if (asset == 10) return "AAPL";
        if (asset == 11) return "MSFT";
        return "TSLA";
    }

    function _tierName(uint8 tier) private pure returns (string memory) {
        if (tier == 1) return "S";
        if (tier == 2) return "SR";
        if (tier == 3) return "SSR";
        if (tier == 4) return "SSSR";
        return "R";
    }

    function _tierColor(uint8 tier, bool sealedBox) private pure returns (string memory) {
        if (sealedBox) return "#d7ff4f";
        if (tier == 1) return "#49caff";
        if (tier == 2) return "#a980ff";
        if (tier == 3) return "#f4c86b";
        if (tier == 4) return "#ff5b9e";
        return "#c5d0de";
    }

    function _styleName(uint8 face) private pure returns (string memory) {
        if (face >= 52) return "Genesis";
        uint8 style = face % 4;
        if (style == 1) return "Neon";
        if (style == 2) return "Gold";
        if (style == 3) return "Holographic";
        return "Classic";
    }

    function _styleColor(uint8 face) private pure returns (string memory) {
        if (face >= 52) return face == 52 ? "#ff9b3d" : "#b388ff";
        uint8 style = face % 4;
        if (style == 1) return "#49caff";
        if (style == 2) return "#f4c86b";
        if (style == 3) return "#ff5bca";
        return "#d7ff4f";
    }
}
