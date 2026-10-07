// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title 灋廌覈鑒 · 贡献积分账本
/// @notice 积分绑定在人身上：只能由登记的发放方「发」或「扣」，没有转账、授权或交易功能，
///         因此不能买卖，不是虚拟货币。每一笔都记下原因和证据指纹，谁都能查。
contract PointsLedger {
    address public owner;
    mapping(address => bool) public isIssuer;
    mapping(bytes32 => uint256) public balanceOf;   // subject = keccak256("openalex:<作者ID>")

    event IssuerSet(address indexed issuer, bool enabled);
    event Awarded(bytes32 indexed subject, uint256 amount, bytes32 indexed reason, bytes32 evidence, address indexed issuer, uint256 balance);
    event Spent(bytes32 indexed subject, uint256 amount, bytes32 indexed reason, bytes32 evidence, address indexed issuer, uint256 balance);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier onlyIssuer() { require(isIssuer[msg.sender], "not issuer"); _; }

    constructor() {
        owner = msg.sender;
        isIssuer[msg.sender] = true;
        emit IssuerSet(msg.sender, true);
    }

    function setIssuer(address issuer, bool enabled) external onlyOwner {
        isIssuer[issuer] = enabled;
        emit IssuerSet(issuer, enabled);
    }

    /// @param reason 规则编号，如 "NEWCOMER" / "REPRODUCE" / "REVIEW"
    /// @param evidence 对应行为的证据指纹（如 ActionRegistry 里那笔记录的 content）
    function award(bytes32 subject, uint256 amount, bytes32 reason, bytes32 evidence) external onlyIssuer {
        require(amount > 0, "amount=0");
        uint256 b = balanceOf[subject] + amount;
        balanceOf[subject] = b;
        emit Awarded(subject, amount, reason, evidence, msg.sender, b);
    }

    function spend(bytes32 subject, uint256 amount, bytes32 reason, bytes32 evidence) external onlyIssuer {
        require(amount > 0, "amount=0");
        uint256 b = balanceOf[subject];
        require(b >= amount, "insufficient points");
        b -= amount;
        balanceOf[subject] = b;
        emit Spent(subject, amount, reason, evidence, msg.sender, b);
    }
}
